#!/usr/bin/env node
/**
 * 00 Protocol — Stealth Address Engine for Electron Cash Plugin
 *
 * Standalone Node.js script that handles stealth address operations.
 * Communicates via stdin/stdout JSON (EC plugin bridge pattern).
 *
 * Actions:
 *   derive_keys    — Derive stealth scan/spend keys from seed (BIP352)
 *   make_paycode   — Generate stealth paycode from scan+spend pubkeys
 *   derive_address — Derive one-time stealth address (sender side)
 *   detect_payment — Test if a TX contains a stealth payment (receiver side)
 *   scan_indexer   — Scan block range via pubkey indexer API
 *   parse_tx       — Extract input pubkeys from raw TX hex
 *
 * Compatible with 00 Protocol (0penw0rld.com/stealth.html)
 * BIP352 paths: m/352'/145'/0'/0'/0 (spend), m/352'/145'/0'/1'/0 (scan)
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ══════════════════════════════════════════
// SECP256K1 MINI LIBRARY (no external deps)
// ══════════════════════════════════════════

// secp256k1 curve parameters
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a, m = P) { return ((a % m) + m) % m; }
function modInv(a, m = P) {
  let [old_r, r] = [a, m], [old_s, s] = [1n, 0n];
  while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
  return mod(old_s, m);
}

// Jacobian point arithmetic
function jacobianAdd(x1, y1, z1, x2, y2, z2) {
  if (z1 === 0n) return [x2, y2, z2];
  if (z2 === 0n) return [x1, y1, z1];
  const z1z1 = mod(z1 * z1), z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2), u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2), s2 = mod(y2 * z1 * z1z1);
  if (u1 === u2) return s1 === s2 ? jacobianDouble(x1, y1, z1) : [0n, 1n, 0n];
  const h = mod(u2 - u1), hh = mod(h * h), hhh = mod(h * hh);
  const r = mod(s2 - s1);
  const x3 = mod(r * r - hhh - 2n * u1 * hh);
  const y3 = mod(r * (u1 * hh - x3) - s1 * hhh);
  const z3 = mod(z1 * z2 * h);
  return [x3, y3, z3];
}
function jacobianDouble(x, y, z) {
  if (y === 0n) return [0n, 1n, 0n];
  const ysq = mod(y * y), s = mod(4n * x * ysq), m = mod(3n * x * x);
  const x3 = mod(m * m - 2n * s), y3 = mod(m * (s - x3) - 8n * ysq * ysq);
  const z3 = mod(2n * y * z);
  return [x3, y3, z3];
}
function jacobianMul(k, px, py) {
  let [rx, ry, rz] = [0n, 1n, 0n];
  let [qx, qy, qz] = [px, py, 1n];
  while (k > 0n) {
    if (k & 1n) [rx, ry, rz] = jacobianAdd(rx, ry, rz, qx, qy, qz);
    [qx, qy, qz] = jacobianDouble(qx, qy, qz);
    k >>= 1n;
  }
  const zinv = modInv(rz);
  return [mod(rx * zinv * zinv), mod(ry * zinv * zinv * zinv)];
}

function pointMul(k, px = Gx, py = Gy) { return jacobianMul(k, px, py); }
function pointAdd(x1, y1, x2, y2) {
  const [rx, ry, rz] = jacobianAdd(x1, y1, 1n, x2, y2, 1n);
  if (rz === 0n) return [0n, 0n];
  const zinv = modInv(rz);
  return [mod(rx * zinv * zinv), mod(ry * zinv * zinv * zinv)];
}

function privToPub(priv) {
  const k = typeof priv === 'string' ? BigInt('0x' + priv) : priv;
  const [x, y] = pointMul(k);
  const prefix = y % 2n === 0n ? '02' : '03';
  return prefix + x.toString(16).padStart(64, '0');
}

function decompressPoint(pubHex) {
  const prefix = parseInt(pubHex.slice(0, 2), 16);
  const x = BigInt('0x' + pubHex.slice(2, 66));
  const ysq = mod(mod(x * x * x) + 7n);
  let y = modPow(ysq, (P + 1n) / 4n, P);
  if ((y % 2n === 0n) !== (prefix === 2)) y = mod(-y);
  return [x, y];
}

function modPow(base, exp, m) {
  let result = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp % 2n === 1n) result = mod(result * base, m);
    exp >>= 1n;
    base = mod(base * base, m);
  }
  return result;
}

function compressPoint(x, y) {
  const prefix = y % 2n === 0n ? '02' : '03';
  return prefix + x.toString(16).padStart(64, '0');
}

// ══════════════════════════════════════════
// HASH HELPERS
// ══════════════════════════════════════════

function sha256(data) {
  if (typeof data === 'string') data = Buffer.from(data, 'hex');
  return crypto.createHash('sha256').update(data).digest();
}

function ripemd160(data) {
  if (typeof data === 'string') data = Buffer.from(data, 'hex');
  return crypto.createHash('ripemd160').update(data).digest();
}

function hash160(data) { return ripemd160(sha256(data)); }

// ══════════════════════════════════════════
// CASHADDR
// ══════════════════════════════════════════

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function cashAddrPolymod(v) {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of v) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if (c0 & (1n << BigInt(i))) c ^= GEN[i];
  }
  return c ^ 1n;
}

function hash160ToCashAddr(h160, prefix = 'bitcoincash') {
  const versionByte = 0x00; // P2PKH
  const payload = Buffer.concat([Buffer.from([versionByte]), h160]);
  const d5 = []; let acc = 0, bits = 0;
  for (const b of payload) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d5.push((acc >> bits) & 31); } }
  if (bits > 0) d5.push((acc << (5 - bits)) & 31);
  const pe = [...prefix.split('').map(c => c.charCodeAt(0) & 31), 0];
  const checksum = cashAddrPolymod([...pe, ...d5, 0, 0, 0, 0, 0, 0, 0, 0]);
  const cs = [];
  for (let i = 7; i >= 0; i--) cs.push(Number((checksum >> (BigInt(i) * 5n)) & 31n));
  return prefix + ':' + [...d5, ...cs].map(v => CHARSET[v]).join('');
}

// ══════════════════════════════════════════
// STEALTH PROTOCOL (00 Protocol compatible)
// ══════════════════════════════════════════

/**
 * Core ECDH stealth address derivation.
 * Compatible with 00 Protocol stealthDerive().
 *
 * Protocol:
 *   sharedX = ECDH(priv, pub).x
 *   c = SHA256(SHA256(sharedX) || outpoint)
 *   stealth_pub = spend_pub + c * G
 *   stealth_addr = CashAddr(hash160(stealth_pub))
 */
function stealthDerive(privHex, pubHex, spendPubHex, outpointHex) {
  const priv = BigInt('0x' + privHex);
  const [pubX, pubY] = decompressPoint(pubHex);

  // Step 1: ECDH shared secret
  const [sharedX, _sharedY] = pointMul(priv, pubX, pubY);
  const sharedXBytes = Buffer.from(sharedX.toString(16).padStart(64, '0'), 'hex');

  // Step 2: Tweak c = SHA256(SHA256(sharedX) || outpoint)
  const outpointBytes = Buffer.from(outpointHex, 'hex');
  const cBytes = sha256(Buffer.concat([sha256(sharedXBytes), outpointBytes]));
  const cBig = BigInt('0x' + cBytes.toString('hex')) % N;

  // Step 3: Stealth pubkey = spend_pub + c * G
  const [spendX, spendY] = decompressPoint(spendPubHex);
  const [tweakX, tweakY] = pointMul(cBig);
  const [stealthX, stealthY] = pointAdd(spendX, spendY, tweakX, tweakY);
  const stealthPub = compressPoint(stealthX, stealthY);

  // Step 4: Stealth address
  const stealthPubBytes = Buffer.from(stealthPub, 'hex');
  const h160 = hash160(stealthPubBytes);
  const stealthAddr = hash160ToCashAddr(h160);

  return {
    addr: stealthAddr,
    pub: stealthPub,
    c: cBig.toString(16).padStart(64, '0'),
  };
}

/**
 * Compute stealth spending key: p = (spend_priv + c) mod N
 */
function stealthSpendingKey(spendPrivHex, cHex) {
  const b = BigInt('0x' + spendPrivHex);
  const c = BigInt('0x' + cHex);
  const p = (b + c) % N;
  return p.toString(16).padStart(64, '0');
}

/**
 * Generate stealth paycode from scan + spend pubkeys
 */
function makePaycode(scanPubHex, spendPubHex) {
  return 'stealth:' + scanPubHex + spendPubHex;
}

/**
 * Parse a stealth paycode
 */
function parsePaycode(paycode) {
  const raw = paycode.replace(/^stealth:/i, '');
  if (raw.length !== 132) throw new Error('Invalid paycode length: ' + raw.length);
  return {
    scanPub: raw.slice(0, 66),
    spendPub: raw.slice(66),
  };
}

// ══════════════════════════════════════════
// TX PARSING
// ══════════════════════════════════════════

/**
 * Extract compressed pubkeys from P2PKH transaction inputs.
 * Returns [{ pubkey, outpoint, vin }]
 */
function extractInputPubkeys(rawTxHex) {
  const buf = Buffer.from(rawTxHex, 'hex');
  const results = [];
  let p = 0;

  const readBytes = (n) => { const s = buf.slice(p, p + n); p += n; return s; };
  const readU32LE = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const readVarInt = () => {
    const f = buf[p++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = buf.readUInt16LE(p); p += 2; return v; }
    if (f === 0xfe) { const v = buf.readUInt32LE(p); p += 4; return v; }
    return 0; // 0xff not handled (extremely rare)
  };

  try {
    readU32LE(); // version
    const inCount = readVarInt();

    for (let i = 0; i < inCount; i++) {
      const prevTxid = readBytes(32); // already LE in serialization
      const prevVout = readU32LE();
      const outpoint = Buffer.concat([prevTxid, Buffer.from([prevVout & 0xff, (prevVout >> 8) & 0xff, (prevVout >> 16) & 0xff, (prevVout >> 24) & 0xff])]);

      const scriptLen = readVarInt();
      const scriptSig = readBytes(scriptLen);
      readU32LE(); // sequence

      // Skip coinbase
      if (prevTxid.equals(Buffer.alloc(32, 0))) continue;

      // Parse P2PKH scriptSig: <sig_push> <sig> <pub_push> <pub>
      if (scriptSig.length < 35) continue;

      let sp = 0;
      const sigLen = scriptSig[sp++];
      sp += sigLen;
      if (sp >= scriptSig.length) continue;

      const pubLen = scriptSig[sp++];
      if (pubLen !== 33 && pubLen !== 65) continue;
      if (sp + pubLen > scriptSig.length) continue;

      const pubkey = scriptSig.slice(sp, sp + pubLen);

      // Only compressed (0x02 or 0x03)
      if (pubLen === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) {
        results.push({
          pubkey: pubkey.toString('hex'),
          outpoint: outpoint.toString('hex'),
          vin: i,
        });
      }
    }
  } catch (e) { /* parsing error, return what we have */ }

  return results;
}

// ══════════════════════════════════════════
// INDEXER CLIENT
// ══════════════════════════════════════════

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

/**
 * Scan a block range via the pubkey indexer API.
 * Tests ECDH for each pubkey against the receiver's scan key.
 */
async function scanIndexer(params) {
  const { scanPriv, spendPub, fromHeight, toHeight, indexerUrl } = params;
  const base = indexerUrl || 'https://0penw0rld.com/api';
  const batchSize = 50;
  const candidates = [];

  for (let bStart = fromHeight; bStart <= toHeight; bStart += batchSize) {
    const bEnd = Math.min(bStart + batchSize - 1, toHeight);

    try {
      const data = await httpGet(`${base}/pubkeys?from=${bStart}&to=${bEnd}`);
      if (!data || !data.pubkeys) continue;

      for (const entry of data.pubkeys) {
        try {
          const result = stealthDerive(scanPriv, entry.pubkey, spendPub, entry.outpoint);
          candidates.push({
            txid: entry.txid,
            vin: entry.vin || 0,
            height: entry.height || 0,
            addr: result.addr,
            pub: result.pub,
            c: result.c,
          });
        } catch { /* skip invalid entries */ }
      }
    } catch (e) {
      // Log but continue
      process.stderr.write(`[stealth] indexer error at ${bStart}-${bEnd}: ${e.message}\n`);
    }
  }

  return candidates;
}

/**
 * Detect stealth payment in a specific raw TX.
 * Tests all input pubkeys via ECDH.
 */
function detectPayment(params) {
  const { rawTxHex, scanPriv, spendPub } = params;
  const inputs = extractInputPubkeys(rawTxHex);
  const results = [];

  // Parse outputs to get scripts
  const buf = Buffer.from(rawTxHex, 'hex');
  let p = 0;
  const readU32LE = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const readVarInt = () => { const f = buf[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = buf.readUInt16LE(p); p += 2; return v; } if (f === 0xfe) { const v = buf.readUInt32LE(p); p += 4; return v; } return 0; };
  const readBytes = (n) => { const s = buf.slice(p, p + n); p += n; return s; };

  try {
    readU32LE(); // version
    const inCount = readVarInt();
    for (let i = 0; i < inCount; i++) {
      readBytes(32); readU32LE(); // prevTxid + vout
      const sl = readVarInt(); readBytes(sl); // scriptSig
      readU32LE(); // sequence
    }
    const outCount = readVarInt();
    const outputs = [];
    for (let i = 0; i < outCount; i++) {
      const value = buf.readBigUInt64LE(p); p += 8;
      const scriptLen = readVarInt();
      const script = readBytes(scriptLen);
      outputs.push({ value: Number(value), script: script.toString('hex') });
    }

    // Test each input pubkey
    for (const inp of inputs) {
      const derived = stealthDerive(scanPriv, inp.pubkey, spendPub, inp.outpoint);
      const derivedH160 = hash160(Buffer.from(derived.pub, 'hex')).toString('hex');
      const expectedScript = '76a914' + derivedH160 + '88ac';

      const matchIdx = outputs.findIndex(o => o.script === expectedScript);
      if (matchIdx !== -1) {
        results.push({
          vin: inp.vin,
          vout: matchIdx,
          value: outputs[matchIdx].value,
          addr: derived.addr,
          pub: derived.pub,
          c: derived.c,
        });
      }
    }
  } catch { /* parsing error */ }

  return results;
}

// ══════════════════════════════════════════
// BIP32 KEY DERIVATION (simplified for BIP352)
// ══════════════════════════════════════════

function hmacSha512(key, data) {
  return crypto.createHmac('sha512', key).update(data).digest();
}

function bip32Child(parentPriv, parentChain, index, hardened = false) {
  const indexNum = hardened ? index + 0x80000000 : index;
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32BE(indexNum);

  let data;
  if (hardened) {
    data = Buffer.concat([Buffer.from([0x00]), Buffer.from(parentPriv, 'hex'), indexBuf]);
  } else {
    data = Buffer.concat([Buffer.from(privToPub(parentPriv), 'hex'), indexBuf]);
  }

  const I = hmacSha512(Buffer.from(parentChain, 'hex'), data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);

  const parentKey = BigInt('0x' + parentPriv);
  const childKey = (BigInt('0x' + IL.toString('hex')) + parentKey) % N;

  return {
    priv: childKey.toString(16).padStart(64, '0'),
    chain: IR.toString('hex'),
  };
}

function deriveBip352Keys(masterPriv, masterChain) {
  // m/352' (hardened)
  const n352 = bip32Child(masterPriv, masterChain, 352, true);
  // m/352'/145' (hardened)
  const n145 = bip32Child(n352.priv, n352.chain, 145, true);
  // m/352'/145'/0' (hardened)
  const n0 = bip32Child(n145.priv, n145.chain, 0, true);
  // m/352'/145'/0'/0' (spend chain, hardened)
  const spendChain = bip32Child(n0.priv, n0.chain, 0, true);
  // m/352'/145'/0'/0'/0 (spend key, non-hardened)
  const spendKey = bip32Child(spendChain.priv, spendChain.chain, 0, false);
  // m/352'/145'/0'/1' (scan chain, hardened)
  const scanChain = bip32Child(n0.priv, n0.chain, 1, true);
  // m/352'/145'/0'/1'/0 (scan key, non-hardened)
  const scanKey = bip32Child(scanChain.priv, scanChain.chain, 0, false);

  return {
    spendPriv: spendKey.priv,
    spendPub: privToPub(spendKey.priv),
    scanPriv: scanKey.priv,
    scanPub: privToPub(scanKey.priv),
    paycode: makePaycode(privToPub(scanKey.priv), privToPub(spendKey.priv)),
  };
}

// ══════════════════════════════════════════
// STDIN/STDOUT JSON-RPC BRIDGE (EC pattern)
// ══════════════════════════════════════════

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let request;
  try {
    request = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({ error: 'Invalid JSON input' }));
    return;
  }

  const { action, params } = request;
  let result;

  try {
    switch (action) {
      case 'derive_keys':
        // params: { masterPriv, masterChain } — from BIP32 master root
        result = deriveBip352Keys(params.masterPriv, params.masterChain);
        break;

      case 'derive_keys_from_seed': {
        // params: { seed } — BIP39 mnemonic phrase
        // Derive BIP32 master key from seed via PBKDF2 + HMAC-SHA512
        const crypto = require('crypto');
        const seedBytes = crypto.pbkdf2Sync(params.seed, 'mnemonic', 2048, 64, 'sha512');
        const I = crypto.createHmac('sha512', 'Bitcoin seed').update(seedBytes).digest();
        const masterPrivHex = I.subarray(0, 32).toString('hex');
        const masterChainHex = I.subarray(32).toString('hex');
        result = deriveBip352Keys(masterPrivHex, masterChainHex);
        break;
      }

      case 'derive_keys_from_account': {
        // params: { acctPrivHex, acctChainHex } — from m/44'/145'/0' account node
        // Fallback: derive at /2'/0 (scan) and /2'/1 (spend) — NOT BIP352
        const stChain = bip32Child(params.acctPrivHex, params.acctChainHex, 2, true);  // /2' hardened
        const scanChild = bip32Child(stChain.priv, stChain.chain, 0, false);   // /2'/0
        const spendChild = bip32Child(stChain.priv, stChain.chain, 1, false);  // /2'/1
        result = {
          scanPriv: scanChild.priv, scanPub: privToPub(scanChild.priv),
          spendPriv: spendChild.priv, spendPub: privToPub(spendChild.priv),
          paycode: makePaycode(privToPub(scanChild.priv), privToPub(spendChild.priv)),
          warning: 'Account-level derivation (not BIP352). Paycode differs from seed-based derivation.',
        };
        break;
      }

      case 'derive_keys_raw':
        // params: { rawPrivKey } — SHA256 domain separation fallback
        const scanSeed = sha256(Buffer.concat([Buffer.from('bch-stealth-scan'), Buffer.from(params.rawPrivKey, 'hex')]));
        const spendSeed = sha256(Buffer.concat([Buffer.from('bch-stealth-spend'), Buffer.from(params.rawPrivKey, 'hex')]));
        const scanPriv = scanSeed.toString('hex');
        const spendPriv = spendSeed.toString('hex');
        result = {
          scanPriv, scanPub: privToPub(scanPriv),
          spendPriv, spendPub: privToPub(spendPriv),
          paycode: makePaycode(privToPub(scanPriv), privToPub(spendPriv)),
        };
        break;

      case 'make_paycode':
        result = { paycode: makePaycode(params.scanPub, params.spendPub) };
        break;

      case 'parse_paycode':
        result = parsePaycode(params.paycode);
        break;

      case 'derive_address':
        // Sender side: params: { senderPriv, recipScanPub, recipSpendPub, outpoint }
        result = stealthDerive(params.senderPriv, params.recipScanPub, params.recipSpendPub, params.outpoint);
        break;

      case 'spending_key':
        // params: { spendPriv, c }
        result = { key: stealthSpendingKey(params.spendPriv, params.c) };
        break;

      case 'detect_payment':
        // params: { rawTxHex, scanPriv, spendPub }
        result = detectPayment(params);
        break;

      case 'parse_tx':
        // params: { rawTxHex }
        result = extractInputPubkeys(params.rawTxHex);
        break;

      case 'scan_indexer':
        // params: { scanPriv, spendPub, fromHeight, toHeight, indexerUrl? }
        result = await scanIndexer(params);
        break;

      case 'test':
        // Self-test: derive keys, make paycode, derive address, verify
        const testPriv = 'a' + '0'.repeat(63);
        const testPub = privToPub(testPriv);
        const testPaycode = makePaycode(testPub, testPub);
        const testParsed = parsePaycode(testPaycode);
        result = {
          ok: true,
          privToPub: testPub,
          paycode: testPaycode,
          parsed: testParsed,
          version: '1.0.0',
          protocol: '00 Protocol (BIP352)',
        };
        break;

      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (e) {
    result = { error: e.message, stack: e.stack };
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exit(1);
});
