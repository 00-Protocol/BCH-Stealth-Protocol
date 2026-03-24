#!/usr/bin/env python3
"""
Stealth Addresses Plugin — Core Logic (JS Bridge)

Uses stealth.js via Node.js subprocess for all crypto operations.
Compatible with 00 Protocol (0penw0rld.com/stealth.html)
BIP352 key derivation: m/352'/145'/0'/0'/0 (spend), m/352'/145'/0'/1'/0 (scan)
"""

import json
import os
import subprocess
import threading
import time
from typing import Optional, List

from electroncash.plugins import BasePlugin, hook
from electroncash.util import PrintError


class StealthPlugin(BasePlugin):
    """
    Stealth Addresses Plugin for Electron Cash.
    All crypto is delegated to stealth.js via Node.js.
    """

    def __init__(self, parent, config, name):
        super().__init__(parent, config, name)
        self.stealth_data = {}    # wallet_id -> { keys, utxos }
        self.lock = threading.Lock()
        self._node_path = self._find_node()

    def _find_node(self):
        """Find Node.js binary."""
        for p in ['node', '/usr/bin/node', '/usr/local/bin/node']:
            try:
                r = subprocess.run([p, '--version'], capture_output=True, text=True, timeout=5)
                if r.returncode == 0:
                    self.print_error(f'Found Node.js: {p} ({r.stdout.strip()})')
                    return p
            except Exception:
                continue
        self.print_error('Node.js not found! Stealth plugin requires Node.js 18+')
        return None

    def _stealth_js_path(self):
        """Get path to stealth.js script."""
        return os.path.join(os.path.dirname(__file__), 'scripts', 'stealth.js')

    def _call_js(self, action: str, params: dict) -> dict:
        """Call stealth.js with an action and params, return result."""
        if not self._node_path:
            return {'error': 'Node.js not available'}

        js_path = self._stealth_js_path()
        if not os.path.exists(js_path):
            return {'error': f'stealth.js not found at {js_path}'}

        try:
            input_json = json.dumps({'action': action, 'params': params})
            result = subprocess.run(
                [self._node_path, js_path],
                input=input_json,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode != 0:
                return {'error': f'stealth.js error: {result.stderr}'}
            return json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            return {'error': 'stealth.js timeout'}
        except json.JSONDecodeError:
            return {'error': f'Invalid JSON from stealth.js: {result.stdout[:200]}'}
        except Exception as e:
            return {'error': str(e)}

    def fullname(self):
        return 'Stealth Addresses'

    def description(self):
        return 'ECDH beaconless stealth addresses (BIP352, 00 Protocol compatible)'

    @hook
    def load_wallet(self, wallet, window=None):
        """Derive stealth keys when a wallet is loaded."""
        wallet_id = id(wallet)
        try:
            ks = wallet.get_keystore()

            # Check if BIP32 (seed phrase)
            from electroncash import keystore
            self.print_error(f'Wallet {wallet_id}: keystore type = {type(ks).__name__}')

            if isinstance(ks, keystore.BIP32_KeyStore):
                # BIP352 requires derivation from MASTER SEED, not account xprv
                # EC's get_master_private_key() returns m/44'/145'/0' (account level)
                # We need the RAW SEED to derive m/352'/145'/0'/...
                result = None

                # Strategy 1: Get seed phrase directly (best — gives us BIP39 master key)
                seed = None
                for pwd in [None, '']:
                    try:
                        seed = ks.get_seed(pwd)
                        if seed:
                            break
                    except Exception:
                        pass

                if seed:
                    self.print_error(f'  Got seed phrase, deriving BIP352 keys via JS...')
                    result = self._call_js('derive_keys_from_seed', {
                        'seed': seed,
                    })
                else:
                    # Strategy 2: Fallback to account xprv (derives from m/44'/145'/0'/2'/x — old path)
                    self.print_error(f'  No seed available, falling back to account-level derivation')
                    xprv = None
                    for pwd in [None, '']:
                        try:
                            xprv = ks.get_master_private_key(pwd)
                            if xprv:
                                break
                        except Exception as e:
                            self.print_error(f'  get_master_private_key({pwd!r}) failed: {e}')

                    if not xprv:
                        xprv = getattr(ks, 'xprv', None)

                    if not xprv:
                        self.print_error(f'Wallet {wallet_id}: cannot access seed or xprv')
                        return

                    self.print_error(f'  Got xprv (account level): {xprv[:20]}...')
                    try:
                        from electroncash.bitcoin import deserialize_xprv
                        result_tuple = deserialize_xprv(xprv)
                        if len(result_tuple) == 6:
                            xtype, depth, fingerprint, child_number, chain_bytes, priv_bytes = result_tuple
                        else:
                            self.print_error(f'  Unexpected tuple length: {len(result_tuple)}')
                            return
                        # Strip leading 0x00 byte from private key
                        if isinstance(priv_bytes, (bytes, bytearray)) and len(priv_bytes) == 33 and priv_bytes[0] == 0:
                            priv_bytes = priv_bytes[1:]
                        priv_hex = priv_bytes.hex() if isinstance(priv_bytes, (bytes, bytearray)) else priv_bytes
                        chain_hex = chain_bytes.hex() if isinstance(chain_bytes, (bytes, bytearray)) else chain_bytes

                        self.print_error(f'  WARNING: Using account-level derivation (m/44\'/145\'/0\'/2\'/x)')
                        self.print_error(f'  This produces a DIFFERENT paycode than BIP352 master derivation')
                        result = self._call_js('derive_keys_from_account', {
                            'acctPrivHex': priv_hex,
                            'acctChainHex': chain_hex,
                        })
                    except Exception as e:
                        self.print_error(f'  deserialize_xprv error: {e}')
                        import traceback
                        self.print_error(traceback.format_exc())
                        return

            elif hasattr(ks, 'get_private_key'):
                self.print_error(f'Wallet {wallet_id}: imported key, trying SHA256 fallback')
                return
            else:
                self.print_error(f'Wallet {wallet_id}: unsupported keystore type: {type(ks).__name__}')
                return

            if 'error' in result:
                self.print_error(f'Wallet {wallet_id}: stealth error: {result["error"]}')
                return

            with self.lock:
                self.stealth_data[wallet_id] = {
                    'keys': result,
                    'utxos': self._load_utxos(wallet),
                }

            self.print_error(f'Wallet {wallet_id}: stealth keys derived')
            self.print_error(f'  Paycode: {result.get("paycode", "?")[:40]}...')

        except Exception as e:
            self.print_error(f'Wallet {wallet_id}: stealth init error: {e}')

    @hook
    def close_wallet(self, wallet):
        """Clean up when wallet closes."""
        with self.lock:
            self.stealth_data.pop(id(wallet), None)

    @hook
    def spendable_coin_filter(self, window, coins):
        """Exclude stealth UTXOs from normal coin selection."""
        data = self.stealth_data.get(id(window.wallet))
        if not data or not data.get('utxos'):
            return
        stealth_addrs = {u['addr'] for u in data['utxos']}
        coins[:] = [c for c in coins if c.get('address') not in stealth_addrs]

    def get_paycode(self, wallet) -> Optional[str]:
        """Get stealth paycode."""
        data = self.stealth_data.get(id(wallet))
        if data and data.get('keys'):
            return data['keys'].get('paycode')
        return None

    def get_stealth_balance(self, wallet) -> int:
        """Get total stealth balance in satoshis."""
        data = self.stealth_data.get(id(wallet))
        if not data:
            return 0
        return sum(u.get('value', 0) for u in data.get('utxos', []))

    def detect_payment(self, wallet, raw_tx_hex: str) -> list:
        """Detect stealth payments in a raw TX."""
        data = self.stealth_data.get(id(wallet))
        if not data or not data.get('keys'):
            return []
        keys = data['keys']
        return self._call_js('detect_payment', {
            'rawTxHex': raw_tx_hex,
            'scanPriv': keys['scanPriv'],
            'spendPub': keys['spendPub'],
        })

    def scan_blocks(self, wallet, from_height: int, to_height: int) -> int:
        """Scan blocks via indexer. Returns count of found UTXOs."""
        data = self.stealth_data.get(id(wallet))
        if not data or not data.get('keys'):
            self.print_error('scan_blocks: no stealth keys')
            return 0
        keys = data['keys']
        self.print_error(f'scan_blocks: scanning {from_height}-{to_height}...')
        try:
            candidates = self._call_js('scan_indexer', {
                'scanPriv': keys['scanPriv'],
                'spendPub': keys['spendPub'],
                'fromHeight': from_height,
                'toHeight': to_height,
                'indexerUrl': 'https://0penw0rld.com/api',
            })
        except Exception as e:
            self.print_error(f'scan_blocks JS error: {e}')
            return 0

        if isinstance(candidates, dict) and 'error' in candidates:
            self.print_error(f'scan_blocks error: {candidates["error"]}')
            return 0

        if not isinstance(candidates, list):
            self.print_error(f'scan_blocks: unexpected result type: {type(candidates)}')
            return 0

        self.print_error(f'scan_blocks: {len(candidates)} candidates from indexer')

        # Each candidate has: txid, vin, height, addr, pub, c
        # Verify each candidate has UTXOs on-chain via the wallet's network
        found = 0
        existing_utxos = data.get('utxos', [])
        existing_txids = {(u['txid'], u.get('vout', 0)) for u in existing_utxos}

        for cand in candidates:
            txid = cand.get('txid', '')
            addr = cand.get('addr', '')

            # Skip if already known
            if (txid, cand.get('vin', 0)) in existing_txids:
                continue

            # Verify the address has UTXOs on-chain
            try:
                from electroncash.address import Address
                addr_obj = Address.from_string(addr)
                sh = addr_obj.to_scripthash_hex()

                # Query via wallet's network
                network = wallet.network
                if network:
                    result = network.synchronous_get(('blockchain.scripthash.listunspent', [sh]))
                    if result and len(result) > 0:
                        for utxo in result:
                            new_utxo = {
                                'txid': utxo.get('tx_hash', txid),
                                'vout': utxo.get('tx_pos', 0),
                                'value': utxo.get('value', 0),
                                'height': utxo.get('height', cand.get('height', 0)),
                                'addr': addr,
                                'pub': cand.get('pub', ''),
                                'c': cand.get('c', ''),
                                'from': 'indexer-scan',
                            }
                            existing_utxos.append(new_utxo)
                            found += 1
                            self.print_error(f'  FOUND stealth UTXO: {txid[:16]}... {utxo.get("value",0)} sats')
                else:
                    # No network, just add as unverified
                    new_utxo = {
                        'txid': txid,
                        'vout': cand.get('vin', 0),
                        'value': 0,
                        'height': cand.get('height', 0),
                        'addr': addr,
                        'pub': cand.get('pub', ''),
                        'c': cand.get('c', ''),
                        'from': 'indexer-scan-unverified',
                    }
                    existing_utxos.append(new_utxo)
                    found += 1
            except Exception as e:
                self.print_error(f'  Verify error for {addr[:20]}: {e}')

        if found > 0:
            data['utxos'] = existing_utxos
            self._save_utxos(wallet)
            self.print_error(f'scan_blocks: saved {found} new stealth UTXOs')

        return found

    def _utxo_file(self, wallet) -> str:
        return wallet.storage.path + '.stealth_utxos'

    def _save_utxos(self, wallet):
        data = self.stealth_data.get(id(wallet))
        if not data:
            return
        try:
            with open(self._utxo_file(wallet), 'w') as f:
                json.dump(data.get('utxos', []), f)
        except Exception as e:
            self.print_error(f'Save UTXOs error: {e}')

    def _load_utxos(self, wallet) -> list:
        path = self._utxo_file(wallet)
        if not os.path.exists(path):
            return []
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return []
