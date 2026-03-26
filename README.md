# BCH Stealth Protocol

**Stealth + Fusion + Onion — one pipeline, maximum privacy for Bitcoin Cash.**

No other BCH wallet offers this. One button. All three, always.

---

## What Is It?

The BCH Stealth Protocol is a unified privacy pipeline that chains three cryptographic primitives into a single automatic flow triggered on every receive:

```
 Receive BCH
      │
      ▼
 ┌─────────────────────────────────┐
 │  1. ONION (00 Onion)            │  Multi-hop HTLC routing over BCH
 │     Nostr-coordinated relays    │  Hides sender origin, breaks IP analysis
 └──────────────┬──────────────────┘
                │
                ▼
 ┌─────────────────────────────────┐
 │  2. FUSION (00 Joiner)          │  CashFusion-style CoinJoin mixing
 │     6-phase, Nostr-coordinated  │  Breaks on-chain input/output linkage
 └──────────────┬──────────────────┘
                │
                ▼
 ┌─────────────────────────────────┐
 │  3. STEALTH (00 Protocol)       │  Beaconless ECDH one-time address
 │     No OP_RETURN, no beacon     │  Receiver unlinkable, unannounced
 └──────────────┬──────────────────┘
                │
                ▼
      Funds arrive at stealth address
      Receiver scans via Pubkey Indexer
```

Each component closes a different privacy leak:

| Component | What it closes |
|-----------|----------------|
| **Onion** | Network-level: who sent, IP, timing |
| **Fusion** | On-chain: input/output graph linkage |
| **Stealth** | Address graph: receiver identity, payment tracing |

Separating them leaks metadata. Together they form a complete privacy envelope.

---

## Auto Stealth Mode

Single toggle in wallet settings (default ON):

```
Settings
  ┌──────────────────────────────────────┐
  │  ✅ Auto Stealth Mode                │
  │                                      │
  │  Fusion Rounds:  ○1  ●2  ○3  ○4     │
  │                                      │
  │  Pipeline: Onion → Fusion → Stealth  │
  └──────────────────────────────────────┘
```

When ON, every incoming UTXO automatically routes through all three stages. No manual steps. Configurable Fusion rounds (1–4): more rounds = more privacy.

---

## Protocol Components

### 1. Stealth Addresses (00 Protocol)

Beaconless ECDH stealth addresses on BCH. No OP_RETURN. No on-chain announcement. Sender derives a unique one-time address per payment; receiver scans the blockchain to find payments.

**Receiver publishes a paycode:**
```
stealth:<scan_pubkey_66hex><spend_pubkey_66hex>
```

**Sender flow:**
```
1. Take first input private key  →  derive pubkey P_sender
2. Compute shared secret:  S = ECDH(scan_pub_receiver, p_sender_priv)
3. Derive one-time address:  addr = Hash(S)·G + spend_pub_receiver
4. Send BCH to addr
5. Notify receiver via encrypted Nostr DM: { txid }
```

**Receiver scanning flow:**
```
1. Download all P2PKH input pubkeys for block range  ←  Pubkey Indexer
2. For each pubkey P:  S = ECDH(scan_priv, P)
3. Derive:  addr_candidate = Hash(S)·G + spend_pub
4. Check UTXO set  →  match = payment received
5. Spend key:  k = spend_priv + Hash(S)
```

**Key derivation:**
```
BIP39 seed:   m/352'/145'/0'/0/i  (scan key)
              m/352'/145'/0'/1/i  (spend key)

Raw hex key:  scan_key  = SHA256("bch-stealth-scan:"  || raw_key)
              spend_key = SHA256("bch-stealth-spend:" || raw_key)
```

**BCH ecosystem derivation tree**

Three independent purpose branches from the same seed, no collisions:

```

master seed
├── m/44'/145'/0'     ← regular wallet (BIP44)
│    ├── /0  receive  (non-hardened)
│    └── /1  change   (non-hardened)
│
├── m/47'/145'/0'     ← RPA paycodes (BIP47-SP style)
│    ├── /0' spend branch (hardened gate)  <- isolated from scan
│    │    └── /0      key (non-hardened) (m/47'/145'/0'/0'/0)
│    └── /1' scan branch  (hardened gate)  <- isolated from spend
│         └── /0      key (non-hardened) (m/47'/145'/0'/1'/0)
│
└── m/352'/145'/0'    ← BCH Stealth (BIP352 structure)
     ├── /0' spend branch (hardened gate)  <- isolated from scan
     │    └── /0      key (non-hardened) (m/352'/145'/0'/0'/0)
     └── /1' scan branch  (hardened gate)  <- isolated from spend
          └── /0      key (non-hardened) (m/352'/145'/0'/1'/0)


```

Each protocol owns its own tree. Recoverable by any wallet that knows the purpose numbers.

---

### 2. P2PKH Pubkey Indexer

The scanning backbone for stealth address detection. Serves all compressed pubkeys from P2PKH transaction inputs for any BCH block range. The server never sees your scan key — it returns all pubkeys, and wallets filter locally.

**Source code:** [`indexer/pubkey-indexer.js`](indexer/pubkey-indexer.js)

**Architecture:**

```
         ┌──────────────────────────────────────┐
         │            Source Layer               │
         │                                       │
         │  Mode A: Fulcrum (WSS)                │
         │  - Public Fulcrum electrum servers    │
         │  - blockchain.block.get(height)       │
         │  - No node required, default mode     │
         │                                       │
         │  Mode B: Local Node (BCHN JSON-RPC)   │
         │  - getblock(hash, 2) or raw parse     │
         │  - Full data sovereignty              │
         │  - For Start9 / self-hosters          │
         └───────────────┬──────────────────────┘
                         │ raw tx bytes
                         ▼
         ┌──────────────────────────────────────┐
         │            Extract Layer              │
         │                                       │
         │  Parse P2PKH scriptSig per input:     │
         │    [sig_push 0x47-0x49][sig][0x21]   │
         │    [33-byte compressed pubkey]        │
         │    validate: prefix 0x02 or 0x03     │
         │                                       │
         │  Output per entry:                    │
         │    txid (current tx, 32 bytes)        │
         │    vin index (1 byte)                 │
         │    pubkey (33 bytes)                  │
         │    outpoint txid (32 bytes)           │
         │    outpoint vout (4 bytes)            │
         └───────────────┬──────────────────────┘
                         │
               ┌─────────┴─────────┐
               │                   │
         ┌─────▼──────┐     ┌──────▼──────┐
         │ JSON cache │     │ Binary cache │
         │ per block  │     │  per block   │
         └─────┬──────┘     └──────┬───────┘
               │                   │
    ┌──────────┼───────────────────┼──────────┐
    │          │                   │          │
 ┌──▼───┐  ┌───▼───┐        ┌─────▼───┐  ┌───▼────┐
 │ HTTP │  │  Tor  │        │ Binary  │  │Library │
 │ API  │  │.onion │        │ stdout  │  │import  │
 │:3847 │  │Start9 │        │ (pipe)  │  │(JS/TS) │
 └──┬───┘  └───┬───┘        └─────┬───┘  └───┬────┘
    │           │                 │           │
    ▼           ▼                 ▼           ▼
00-Wallet  Remote wallets   CLI/desktop   EC plugin
browser    over Tor         app           any wallet
```

**P2PKH scriptSig parsing:**
```
Input scriptSig:
  [push: 0x47–0x49]  →  DER signature (71–73 bytes) + sighash type
  [0x21]             →  push 33 bytes
  [pubkey: 33 bytes] →  0x02 or 0x03 prefix = valid compressed point
```

**Binary wire format:**

Stream entry — `scan --format binary` stdout, **69 bytes**:
```
┌─────────────┬──────────────────┬──────────────┐
│   pubkey    │  outpoint_txid   │ outpoint_vout│
│   33 bytes  │    32 bytes      │   4 bytes    │
│  0x02/0x03  │   big-endian     │   LE uint32  │
└─────────────┴──────────────────┴──────────────┘
```

File entry — stored in `.bin` block cache, **106 bytes**:
```
┌──────────┬──────────┬─────┬─────────────┬──────────────────┬──────────────┐
│  height  │   txid   │ vin │   pubkey    │  outpoint_txid   │ outpoint_vout│
│  4 bytes │ 32 bytes │ 1 b │   33 bytes  │    32 bytes      │   4 bytes    │
│  LE u32  │ big-end  │ u8  │  0x02/0x03  │   big-endian     │   LE u32     │
└──────────┴──────────┴─────┴─────────────┴──────────────────┴──────────────┘
```

Block file header — precedes each block's entries, **8 bytes**:
```
┌──────────┬──────────┐
│  height  │  count   │     followed by count × 106-byte entries
│  4 bytes │  4 bytes │     Seekable: read header → skip count×106 → next block
│  LE u32  │  LE u32  │
└──────────┴──────────┘
```

**HTTP API:**
```
GET /api/pubkeys?from={height}&to={height}              → JSON
GET /api/pubkeys?from={height}&to={height}&format=binary → binary stream
GET /api/health                                          → service status
GET /api/stats                                           → cache statistics
```

JSON response example:
```json
{
  "from": 943000, "to": 943001,
  "entries": [
    {
      "height": 943000,
      "txid": "aabbcc...",
      "vin": 0,
      "pubkey": "02a1b2c3...",
      "outpointTxid": "ddeeff...",
      "outpointVout": 1
    }
  ]
}
```

**CLI:**
```bash
# HTTP API server on port 3847
pubkey-indexer serve

# Stream JSON lines to stdout
pubkey-indexer scan --from 943000 --to 943100

# Stream compact 69-byte binary records
pubkey-indexer scan --from 943000 --format binary

# Use local BCHN node
pubkey-indexer scan --from 943000 --source local-node --rpc-url http://localhost:8332

# Custom cache and port
pubkey-indexer serve --cache-dir /data/pubkeys --port 3847
```

**Library usage (Node.js / EC plugin):**
```javascript
const { createScanner } = require('./indexer/pubkey-indexer');

const scanner = createScanner({
  source: 'fulcrum',      // 'fulcrum' or 'local-node'
  rpcUrl: 'http://localhost:8332',
  cacheDir: './cache'
});

// Async generator — streaming, memory-efficient
for await (const entry of scanner.pubkeys(943000, 943100)) {
  // entry: { height, txid: Buffer(32), vin,
  //          pubkey: Buffer(33), outpointTxid: Buffer(32), outpointVout }
  const shared    = secp256k1.getSharedSecret(scanPriv, entry.pubkey);
  const tweak     = sha256(shared);
  const candidate = deriveAddress(spendPub, tweak);
  if (myUtxos.has(candidate)) { /* stealth payment found */ }
}

// All at once
const entries = await scanner.getPubkeys(943000, 943100);
```

---

### 3. Fusion (CoinJoin — 00 Joiner)

Multi-wallet CoinJoin over BCH. No central coordinator — pure Nostr ephemeral events.

**6-phase protocol:**

| Phase | Name | Action |
|-------|------|--------|
| 1 | Announcement | Broadcast intent to join round via Nostr |
| 2 | Registration | Register inputs + onion-blinded outputs |
| 3 | Rounds | Multi-round onion-wrapped output matching |
| 4 | Reveal | Deblind outputs, verify no input/output link |
| 5 | Commit | All peers sign the combined transaction |
| 6 | Broadcast | Submit to BCH network |

Configurable rounds (1–4). Onion-wrapped output registration — no coordinator sees who gets what. Equal-value mixing breaks on-chain linkage.

---

### 4. Onion Routing (00 Onion)

Decentralized Fusion/Silent Joiner relay for encrypted routing and coordination through Nostr.

```

                        Nostr Relays
                       (public infra)
                      /       |       \
        User A  ----+        |        +----  User B
        User C  ----+        |        +----  User D
                      \       |       /
                       Onion Relay
                      /             \
            Fulcrum WSS          BCHN RPC
           (blockchain)         (blockchain)
```
---

## Downloads

Pre-built self-contained binaries. No installation, no Node.js required.

| Platform | File | Size |
|----------|------|------|
| Linux x64 | [`BCH-Pubkey-Indexer-linux`](dist/pubkey-indexer-linux) | ~45 MB |
| macOS Intel | [`BCH-Pubkey-Indexer-mac`](dist/pubkey-indexer-mac) | ~50 MB |
| macOS Apple Silicon | [`BCH-Pubkey-Indexer-mac-arm64`](dist/pubkey-indexer-mac-arm64) | ~45 MB |
| Windows x64 | [`BCH-Pubkey-Indexer-win.exe`](dist/pubkey-indexer-win.exe) | ~37 MB |

**Linux / macOS:**
```bash
chmod +x pubkey-indexer-linux
./pubkey-indexer-linux serve
# → Listening on http://localhost:3847
```

**Windows:**
```powershell
.\pubkey-indexer-win.exe serve
```

> macOS Apple Silicon binaries require ad-hoc code signing:
> `codesign --sign - pubkey-indexer-mac-arm64`

---

## Start9 Deployment

Self-host on [Start9](https://start9.com) (OS 0.4.0+) as a background service with automatic Tor `.onion` access.

**Build the `.s9pk` package:**
```bash
cd indexer/start9
npm ci
make
# → bch-pubkey-indexer.s9pk
start-cli s9pk inspect bch-pubkey-indexer.s9pk
```

**Install:** Sideload `bch-pubkey-indexer.s9pk` via Start9 UI → Services → Sideload.

**What you get:**
- HTTP API on port 3847 (LAN + SSL)
- Tor `.onion` address auto-generated — share with mobile wallet for remote access
- Connects to public Fulcrum servers by default; point to a local BCHN node with `--rpc-url`

---

## Build from Source

**Requirements:** Node.js 18+, npm

```bash
cd indexer
npm install

# Run directly
node pubkey-indexer.js serve

# Build all platform binaries
npm run build:all

# Individual targets
npm run build:linux
npm run build:mac
npm run build:mac-arm
npm run build:win
```

---

## Configuration Reference

CLI flags or environment variables:

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--source` | `SOURCE` | `fulcrum` | `fulcrum` or `local-node` |
| `--fulcrum-url` | `FULCRUM_URL` | auto-rotate | Override Fulcrum WSS server |
| `--rpc-url` | `RPC_URL` | `http://localhost:8332` | BCHN RPC endpoint |
| `--rpc-user` | `RPC_USER` | `rpc` | BCHN RPC username |
| `--rpc-pass` | `RPC_PASS` | _(none)_ | BCHN RPC password |
| `--cache-dir` | `CACHE_DIR` | `./cache/pubkeys` | Block cache directory |
| `--port` | `PORT` | `3847` | HTTP API port |
| `--max-range` | `MAX_RANGE` | `100` | Max blocks per request |

---

## Deployment Matrix

| Target | Format | Transport | Source mode |
|--------|--------|-----------|-------------|
| Start9 server | Docker `.s9pk` | HTTP + Tor `.onion` | Fulcrum or Local BCHN |
| Desktop / AppImage | Single binary | HTTP localhost | Fulcrum or local node |
| CLI pipe | Same binary | stdout binary/JSON | Fulcrum or local node |
| EC plugin / wallet | `require()` | in-process | Fulcrum or local node |

---

## Live

- **00-Wallet:** [0penw0rld.com](https://0penw0rld.com)
- **Stealth spec:** [0penw0rld.com/stealth.html](https://0penw0rld.com/stealth.html)
- **Indexer API:** [0penw0rld.com/indexer.html](https://0penw0rld.com/indexer.html)
- **BCH Research:** [ECDH Stealth Addresses on BCH](https://bitcoincashresearch.org/t/ecdh-stealth-addresses-on-bitcoin-cash-implementation-code/1773)

---

## License

MIT
