# BCH Stealth Protocol

> Privacy infrastructure for Bitcoin Cash — stealth addresses, P2P CoinJoin, blind relay.

**Live wallet → [0penw0rld.com](https://0penw0rld.com)** · **SDK → [@00-protocol/sdk](https://github.com/00-Protocol/sdk)**

---

## What's in this repo

| Path | Description |
|---|---|
| `stealth/` | Electron Cash plugin — stealth address sending/receiving inside EC |
| `indexer/` | BCH Pubkey Indexer — Node.js server for stealth address scanning |
| `dist/` | Pre-built indexer binaries (Linux, macOS, Windows) |

---

## Privacy Pipeline

Three cryptographic primitives chained into a single flow:

```
Receive BCH
    │
    ▼
┌─────────────────────────────────┐
│  BLIND RELAY — Nostr NIP-59     │  Coordinator sees encrypted blobs only
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  FUSION — P2P CoinJoin          │  Breaks input/output graph on-chain
│  (outputs mixed via AES layers) │  Coordinator can't link in → out
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  STEALTH — ECDH one-time addr   │  Receiver unlinkable on-chain
└─────────────────────────────────┘
```

| Component | What it closes |
|---|---|
| **Blind Relay** | Coordinator blindness — messages are NIP-59 gift-wrapped, relay sees only encrypted blobs |
| **Fusion** | On-chain input/output linkage — outputs are layered with per-participant AES-GCM encryption |
| **Stealth** | Address reuse, receiver identity |

> **Note on terminology:** the output-mixing step inside Fusion uses real layered encryption (each output wrapped in N AES-GCM layers, one per participant — true onion routing). The relay itself is a single-hop Nostr relay, not a multi-hop Tor-style network.

---

## Stealth Addresses (BIP352 aggregated ECDH — Final Spec)
Each payment derives a unique, unlinkable P2PKH address. The receiver performs **1 ECDH per TX** regardless of input count (5–10× faster than per-input scanning):

```
BCH Stealth Protocol — Final Spec
══════════════════════════════════

SCOPE
─────
BCH-native stealth payments using ECDH-derived one-time P2PKH outputs.
NOT wire-compatible with BIP-352 silent payments (BTC); BCH has no
Taproot. Cryptographic structure derived from BIP-352; output format
native to BCH.

Classification: Stealth address scheme. One published stealth code
produces an unbounded stream of unlinkable P2PKH outputs. Coexists
with BCH-RPA (m/47') its different trade offs

THREAT MODEL
────────────
Provides:
  • Unlinkability between stealth code and on-chain output address.
  • Unlinkability between distinct payers under per-payer labels.
  • One ECDH per tx for sender and receiver, regardless of input count.
  • Resistance to CoinJoin/Fusion input-set mutation
    (per-input weighting).

Does NOT provide:
  • Amount/timing privacy on a single receive. (Use CashFusion after.)
  • Script-policy privacy. Multisig or covenant spends still reveal
    the redeem script via P2SH. Stealth helps the receive side; the
    spend side leaks policy.
  • Token-content privacy. CashTokens FT amounts and NFT commitments
    are visible on chain.
  • Network-level privacy. Receivers MUST use a local indexer or Tor
    (see RECEIVER scan modes). A third-party Fulcrum can fingerprint
    a scanning client.

CONSTANTS
─────────
N             = secp256k1 group order
G             = secp256k1 generator
TAG_h         = "00proto/stealth/inputs"
TAG_t         = "00proto/stealth/shared"
TAG_label     = "00proto/stealth/label"
H_tag(tag,m)  = SHA256( SHA256(tag) || SHA256(tag) || m )  // BIP-340
GAP           = 3   // consecutive-miss gap-limit for output index scan

The three tag strings above are final. Once mainnet ships, any change
constitutes a hard fork of the scheme.

KEYS  (per account a, account-rotatable)
────────────────────────────────────────
b_scan        = m/352'/145'/a'/1'/0
B_scan        = b_scan · G
b_spend       = m/352'/145'/a'/0'/0
B_spend       = b_spend · G

Default account is a = 0. Wallets MAY expose additional accounts
(a = 1, 2, …) to mint fully independent stealth codes for unrelated
social contexts. Labels (below) are the default per-payer tool;
account rotation is reserved for "burner identity" use cases.

STEALTH CODE  (wire format, identical for labeled and unlabeled)
────────────────────────────────────────────────────────────────
"stealth:" || ser33(B_scan) || ser33(B_spend_m)

For unlabeled global stealth code, m = 0:
  tweak_0   = 0
  B_spend_0 = B_spend

For labeled stealth code, m ≥ 1:
  tweak_m   = H_tag(TAG_label, b_scan || ser32BE(m))   mod N
  B_spend_m = B_spend + tweak_m · G

No version tag on the wire. This is the first stable release; there
is no prior on-chain crypto to support.

INPUT WEIGHTING  (sender and receiver, same rules)
──────────────────────────────────────────────────
op_min = byte-lex min{ outpoint_i }
         outpoint_i = txid_internal_LE(32) || vout_LE(4)
         over ALL tx inputs (including non-contributing peer inputs).

For each input i, contribution is:

  case P2PKH (33-byte compressed pubkey P_i in scriptSig):
    h_i  = H_tag(TAG_h, op_min || P_i)   mod N
    point  contribution: h_i · P_i
    scalar contribution (sender only): h_i · a_i

  case P2SH (revealed redeemScript with N compressed keys K_0..K_{N-1}):
    For each key K_j in redeemScript order:
      h_i_j = H_tag(TAG_h, op_min || K_j || ser32BE(j))   mod N
    point  contribution (sender AND receiver, from on-chain data):
      Σ_j ( h_i_j · K_j )
    scalar contribution (sender only, from privkeys it holds):
      Σ_{j : sender holds k_j} ( h_i_j · k_j )

  case other:
    no contribution. Tx is still scan-eligible if ≥1 input contributes.

Sender precondition:
  Sender's own inputs MUST collectively contribute, AND for each of
  sender's inputs the sender MUST hold every revealed signing key
  (full scalar contribution). This spec supports P2PKH and
  single-party P2SH-multisig (sender holds every k_j). Multi-party
  co-signed multisig is deferred to a future MULTISIG EXTENSION.

a_sum = Σ ( scalar contributions of sender's own inputs )   mod N
A_sum = Σ ( point  contributions of ALL contributing inputs )

SENDER
──────
  shared       = a_sum · B_scan                  // single ECDH
  sharedX      = x-coord(shared)                 // 32 bytes
  For each stealth output k = 0, 1, 2, …:
    t_k        = H_tag(TAG_t, sharedX || ser32BE(k))   mod N
    output_k   = P2PKH( B_spend_m + t_k · G )

Self-change outputs use the SAME path with own (B_scan, B_spend).

RECEIVER
────────
Scan modes (decreasing privacy):
  A. Local BCHN / own indexer — leaks nothing.       (recommended)
  B. Full-block fetch via Fulcrum — leaks "this client scans the
     chain" but NOT which stealth code.              (acceptable)
  C. Per-tx blockchain.transaction.get against a third-party
     Fulcrum — FORBIDDEN unless via Tor with rotating circuits.

Optional NIP-59 gift-wrapped Nostr beacon hint may accompany A/B/C
for latency. Hints are never authoritative; on-chain verification is
required.

For each candidate tx:
  Recompute op_min, the contributing input set, A_sum.
  If A_sum is the identity (no contributing inputs), skip.
  shared       = b_scan · A_sum
  sharedX      = x-coord(shared)

  miss_streak = 0
  For k = 0, 1, 2, …:
    t_k        = H_tag(TAG_t, sharedX || ser32BE(k))   mod N
    matched_this_k = false
    For each m ∈ { 0 } ∪ stored_labels:
      P_out    = B_spend_m + t_k · G
      h160     = HASH160(ser33(P_out))
      if any tx output is P2PKH(h160):
        record { txid, vout, value, tokenData, k, m }
        spendPriv = ( b_spend + tweak_m + t_k )   mod N
        matched_this_k = true
    if matched_this_k: miss_streak = 0
    else:              miss_streak += 1
    if miss_streak ≥ GAP: break

CASHTOKENS
──────────
Stealth outputs MAY carry CashTokens via the standard token_data
field attached to the P2PKH locking script. The stealth derivation
is unchanged.

Sender:
  May attach token_data (FT amount, NFT category+commitment, or both)
  to any output_k. Receiver MUST treat the output's token_data as
  part of the payment.

Receiver:
  After P2PKH hash160 matches, parse token_data alongside the BCH
  value and record { txid, vout, value, tokenData, k, m }.

Per-label policy:
  Each stored label m has a flag accept_tokens ∈
    { bch_only, ft_only, all }.
  Senders SHOULD respect a stealth code's published policy. A
  receiver that has not enabled token-receive on label m discards
  token outputs to that label as undeliverable (BCH amount may still
  be claimed; token portion is unspendable until re-enabled).

Privacy note:
  Stealth hides the recipient address. It does NOT hide token
  contents. NFTs with publicly recognizable commitments leak
  identity at the output level regardless of stealth.

STORAGE
───────
Stealth UTXO cache MUST NOT store privkeys in plaintext at rest.
Wallets MUST either encrypt the cache under the vault key, or store
only { addr, k, m, txid, vout, value, tokenData } and re-derive the
privkey on spend.

RECOMMENDED PRIVACY FLOW
────────────────────────
  payer ──stealth send──▶ recipient stealth UTXO
                            │
                            └─CashFusion──▶ multiple fresh stealth UTXOs
                                            (self-payments at k>0)

A single stealth receive without subsequent fusion provides
sender↔recipient unlinkability but not amount/timing unlinkability.
Wallets SHOULD default to fusing newly received stealth UTXOs before
spending.

WIZARDCONNECT COMPATIBILITY
───────────────────────────
The hardened-gate handshake (Unified Handshake spec) is unchanged.
Existing PathNames and sign_transaction_request / stealthTweak flow
are sufficient. No new WizardConnect methods are proposed.

For remote-wallet sends, the wallet performs a_sum / sharedX
derivation internally (privkeys never leave the wallet) and returns
the fully-signed tx via sign_transaction_request. Receiving and RPA
are entirely wallet-local.
```

No OP_RETURN, or notification transaction. Outputs are indistinguishable from standard P2PKH.

**Paycode format:**
```
stealth:<scan_pubkey_hex_33bytes><spend_pubkey_hex_33bytes>
```

**Key paths (BIP352-style):**
```
m/352'/145'/0'/1'/0   ← scan key  (hardened, isolated tree)
m/352'/145'/0'/0'/0   ← spend key (hardened, isolated tree)
```

## P2P CashFusion

CoinJoin coordinated peer-to-peer over Nostr. No central server, no coordinator service.

**Round protocol:**

| Phase | Action |
|---|---|
| 1. Pool Announce | Broadcast ephemeral pubkey on Nostr (`kind:22230`). Random delay 0–180s (anti-fingerprint) |
| 2. Coordinator Elect | Lowest ephemeral pubkey = coordinator. Deterministic, no vote |
| 3. Round Start | Coordinator sends `round_start` NIP-59 gift-wrapped to each peer |
| 4. Input Registration | Peers reply with signed inputs via encrypted Nostr messages |
| 5. Onion Output Mix | Each output wrapped in N AES-GCM onion layers — coordinator can't link inputs to outputs |
| 6. Verify & Sign | Each peer verifies own outputs present + no inflation. Signs SIGHASH_ALL\|FORKID |
| 7. Broadcast | Coordinator assembles final TX, broadcasts via Fulcrum |

All outputs land on fresh stealth addresses (self-ECDH derivation).

---

## Pubkey Indexer

Privacy-preserving Node.js server that indexes all P2PKH input pubkeys on BCH. Enables client-side stealth scanning without leaking which addresses you control.

**How it works:**
- Server returns **all** compressed pubkeys for a requested block range
- Client filters locally via ECDH — server never learns what you're looking for
- Equivalent privacy to downloading full blocks, ~90% less data

**API:**
```
GET /api/pubkeys?from=<height>&to=<height>   # max 100 blocks/request
GET /api/health
GET /api/stats
```

**Run (Node.js):**
```bash
node indexer/pubkey-indexer.js --fulcrum wss://bch.loping.net:50004 --port 3847
```

**Pre-built binaries** (in `dist/`):
```bash
# Linux
./dist/pubkey-indexer-linux --fulcrum wss://bch.loping.net:50004

# macOS (Apple Silicon)
./dist/pubkey-indexer-mac-arm64 --fulcrum wss://bch.loping.net:50004

# Windows
dist\pubkey-indexer-win.exe --fulcrum wss://bch.loping.net:50004
```
The scanning backbone for stealth address detection. Serves all compressed pubkeys from P2PKH transaction inputs for any BCH block range. The server never sees your scan key — it returns all pubkeys, and wallets filter locally.

Full specification: [0penw0rld.com/indexer.html](https://0penw0rld.com/indexer.html)

**Source code:** [`indexer/pubkey-indexer.js`](indexer/pubkey-indexer.js)

**Key properties:**

- Zero-knowledge: server serves ALL pubkeys for a block range, no information about who you are or what you’re scanning for
- Same privacy as full blocks, ~90% less data (only pubkeys + outpoints)
- Immutable cache: confirmed blocks never change, cached permanently
- Multi-protocol: any ECDH-based privacy protocol can use this data

**Supported protocols:**

|Protocol                            |How it uses the Indexer                                                                   |Status                      |
|------------------------------------|------------------------------------------------------------------------------------------|----------------------------|
|**Stealth Addresses** (00 Protocol) |Download pubkeys, compute ECDH(scan_priv, pubkey), derive one-time address, check UTXO set|Live                        |
|**RPA** (Reusable Payment Addresses)|Download pubkeys, filter by notification prefix, compute ECDH for candidates              |Compatible with this indexer|
|**Confidential Txs**                |Download pubkeys, use covenant scanning logic to identify privacy outputs                 |Compatible with this indexer|

#### Scanning Comparison: Stealth vs RPA

|                  |RPA (prefix grinding)          |Stealth (pubkey indexer)                          |
|------------------|-------------------------------|--------------------------------------------------|
|Sender work       |Grinding (find matching prefix)|None (normal P2PKH)                               |
|Server filtering  |Yes (prefix match via Fulcrum) |None (serves all pubkeys)                         |
|Server learns     |Which prefix you’re watching   |Nothing                                           |
|Anonymity set     |~1/256 of txs                  |All P2PKH txs                                     |
|Data transferred  |Less (filtered subset)         |More (all pubkeys, but much less than full blocks)|
|On-chain footprint|None (grinding is off-chain)   |None                                              |

Both approaches avoid OP_RETURN. RPA trades some anonymity for scan speed. The pubkey indexer preserves full anonymity at the cost of more bandwidth. Two notification layers work together: Nostr DM for instant detection, pubkey indexer chain scan for recovery and periodic scanning.

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
         │    supports DER + Schnorr signatures │
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
    │          │                  │           │
    ▼          ▼                  ▼           ▼
Wallets    Remote wallets    CLI/desktop   EC plugin
browser    over Tor          app           any wallet
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

Block file header — precedes each block’s entries, **8 bytes**:

```
┌──────────┬──────────┐
│  height  │  count   │     followed by count × 106-byte entries
│  4 bytes │  4 bytes │     Seekable: read header → skip count×106 → next block
│  LE u32  │  LE u32  │
└──────────┴──────────┘
```

**HTTP API:**

Base URL: `https://0penw0rld.com/api`

```
GET /api/pubkeys?from={height}&to={height}              → JSON
GET /api/pubkeys?from={height}&to={height}&format=binary → binary stream
GET /api/health                                          → service status
GET /api/stats                                           → cache statistics
```

JSON response example:

```json
{
  "from": 943370, "to": 943372, "count": 660,
  "pubkeys": [
    {
      "height": 943370,
      "txid": "aabbcc...",
      "vin": 0,
      "pubkey": "02a1b2c3...",
      "outpoint": "ddeeff...0000000000"
    }
  ]
}
```

**Data size estimates:**

|Metric                       |Value     |
|-----------------------------|----------|
|Bytes per pubkey entry (JSON)|~250 bytes|
|Average pubkeys per block    |~200-400  |
|Data per block               |~50-100 KB|
|Data per day (~144 blocks)   |~7-15 MB  |
|Data per week                |~50-100 MB|

**Privacy comparison with alternatives:**

|Method                     |Privacy    |Data Size           |Server Knowledge                  |
|---------------------------|-----------|--------------------|----------------------------------|
|Full block download        |Perfect    |~1 MB/block         |None                              |
|**Pubkey Indexer (this)**  |**Perfect**|**~50-100 KB/block**|**None (serves same data to all)**|
|RPA prefix filter (Fulcrum)|Reduced    |~1-5 KB/block       |Knows your prefix                 |
|Electrum scripthash        |Low        |~0.5 KB/query       |Knows exact addresses             |

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

**Redundancy:**

Wallets should support multiple indexer URLs for redundancy. Each indexer serves identical data (blocks are immutable). No coordination needed between operators.

```javascript
const INDEXERS = [
  'https://0penw0rld.com/api',
  'https://your-indexer.example.com/api',
  'https://community-indexer.bch.info/api',
];

async function fetchPubkeys(from, to) {
  for (const base of INDEXERS) {
    try {
      const r = await fetch(`${base}/pubkeys?from=${from}&to=${to}`);
      if (r.ok) return await r.json();
    } catch { continue; }
  }
  throw new Error('All indexers unreachable');
}
```

**Downloads:**

Pre-built self-contained binaries. No installation, no Node.js required.

|Platform           |File                                                           |Size  |
|-------------------|---------------------------------------------------------------|------|
|Linux x64          |[`BCH-Pubkey-Indexer-linux`](dist/pubkey-indexer-linux)        |~45 MB|
|macOS Intel        |[`BCH-Pubkey-Indexer-mac`](dist/pubkey-indexer-mac)            |~50 MB|
|macOS Apple Silicon|[`BCH-Pubkey-Indexer-mac-arm64`](dist/pubkey-indexer-mac-arm64)|~45 MB|
|Windows x64        |[`BCH-Pubkey-Indexer-win.exe`](dist/pubkey-indexer-win.exe)    |~37 MB|

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

**Self-host your own indexer:**

The more indexers run by different operators, the more resilient the privacy infrastructure. Running your own takes 5 minutes.

Requirements: Node.js 18+, npm, ~50 MB RAM, ~1 GB disk/year

```bash
mkdir pubkey-indexer && cd pubkey-indexer
wget https://0penw0rld.com/pubkey-indexer.js
npm init -y
npm install ws

node pubkey-indexer.js
# → http://localhost:3847

curl http://localhost:3847/api/health
# {"status":"ok","fulcrum":true,"cached":0}
```

No BCH node required. The indexer connects to public Fulcrum servers via WebSocket. Point to your own Fulcrum instance or BCH Node for maximum sovereignty.

**Production (systemd):**

```bash
sudo cat > /etc/systemd/system/pubkey-indexer.service << 'EOF'
[Unit]
Description=BCH P2PKH Pubkey Indexer
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/pubkey-indexer
ExecStart=/usr/bin/node pubkey-indexer.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable pubkey-indexer
sudo systemctl start pubkey-indexer
```

**Reverse proxy (nginx):**

```
location /api/ {
    proxy_pass http://127.0.0.1:3847;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
    add_header Access-Control-Allow-Origin * always;
}
```

**Pre-warm cache (optional):**

```bash
for i in $(seq 940000 100 943000); do
  curl -s "http://localhost:3847/api/pubkeys?from=$i&to=$((i+99))" | jq .count
  sleep 2
done
```

First indexing is slow (~5-15 seconds per block on first fetch). Subsequent requests are instant (cached).

**Start9 deployment:**

Self-host on [Start9](https://start9.com) (OS 0.4.0+) as a background service with automatic Tor `.onion` access.

```bash
cd indexer/start9
npm ci
make
# → bch-pubkey-indexer.s9pk
start-cli s9pk inspect bch-pubkey-indexer.s9pk
```

Install: Sideload `bch-pubkey-indexer.s9pk` via Start9 UI → Services → Sideload.

What you get:

- HTTP API on port 3847 (LAN + SSL)
- Tor `.onion` address auto-generated — share with mobile wallet for remote access
- Connects to public Fulcrum servers by default; point to a local BCHN node with `--rpc-url`

**Build from source:**

Requirements: Node.js 18+, npm

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

**Configuration reference:**

CLI flags or environment variables:

|Flag           |Env          |Default                |Description                |
|---------------|-------------|-----------------------|---------------------------|
|`--source`     |`SOURCE`     |`fulcrum`              |`fulcrum` or `local-node`  |
|`--fulcrum-url`|`FULCRUM_URL`|auto-rotate            |Override Fulcrum WSS server|
|`--rpc-url`    |`RPC_URL`    |`http://localhost:8332`|BCHN RPC endpoint          |
|`--rpc-user`   |`RPC_USER`   |`rpc`                  |BCHN RPC username          |
|`--rpc-pass`   |`RPC_PASS`   |*(none)*               |BCHN RPC password          |
|`--cache-dir`  |`CACHE_DIR`  |`./cache/pubkeys`      |Block cache directory      |
|`--port`       |`PORT`       |`3847`                 |HTTP API port              |
|`--max-range`  |`MAX_RANGE`  |`100`                  |Max blocks per request     |

**Deployment matrix:**

|Target            |Format        |Transport          |Source mode          |
|------------------|--------------|-------------------|---------------------|
|Start9 server     |Docker `.s9pk`|HTTP + Tor `.onion`|Fulcrum or Local BCHN|
|Desktop / AppImage|Single binary |HTTP localhost     |Fulcrum or local node|
|CLI pipe          |Same binary   |stdout binary/JSON |Fulcrum or local node|
|EC plugin / wallet|`require()`   |in-process         |Fulcrum or local node|
---

## Electron Cash Plugin

Adds stealth address support directly to [Electron Cash](https://electroncash.org/).

**Install:**
1. In Electron Cash → Tools → Installed Plugins → Add Plugin
2. Select the `stealth/` folder
3. Restart EC

**Features:**
- Generate and share your stealth paycode
- Detect incoming stealth payments via indexer scan
- Spend stealth UTXOs like normal coins

**Requires:** Node.js (for ECDH derivation via `stealth.js`)


-----

## WizardConnect Integration

WizardConnect is the BCH-first dapp/wallet bridge protocol (Nostr NIP-17 transport) that enables any wallet to participate in stealth address sending and Fusion without implementing the full privacy pipeline internally.

Full specification: [0penw0rld.com/wizard.html](https://0penw0rld.com/wizard.html)
BCR discussion: [Unified Handshake for BCH Stealth Addresses and RPA](https://bitcoincashresearch.org/t/ecdh-stealth-addresses-on-bitcoin-cash-implementation-code/1773/5)

**Architecture: Wallet / WizardConnect / DApp interaction**

```
┌──────────────────────────────────────────────────────────────────────┐
│                            WALLET                                    │
│                                                                      │
│  Holds master seed. Derives to hardened level and exports xpubs.     │
│  Signs transactions via sign_transaction_request.                    │
│  Responsible for scanning and receiving stealth payments.            │
│                                                                      │
│  Exports in handshake:                                               │
│    stealth_spend xpub  (from m/352'/145'/0'/0')                      │
│    stealth_scan  xpub  (from m/352'/145'/0'/1')                      │
│    rpa_spend     xpub  (from m/47'/145'/0'/0')                       │
│    rpa_scan      xpub  (from m/47'/145'/0'/1')                       │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               │  WizardConnect handshake
                               │  (Nostr NIP-17 transport)
                               │  xpubs + sign_transaction_request
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                            DAPP                                      │
│                                                                      │
│  Receives xpubs. Derives final non-hardened /0 child locally.        │
│  Performs all ECDH math, constructs transactions, derives stealth    │
│  change addresses. Sends sign_transaction_request to wallet.         │
│                                                                      │
│  Stealth sending: dapp does ECDH, builds P2PKH, wallet signs.       │
│  Stealth spending: dapp passes stealthTweak per input so wallet      │
│    computes p = spendPriv + tweak (mod n) and signs.                 │
│  Fusion/Joiner: dapp coordinates rounds, wallet signs inputs.        │
└──────────────────────────────────────────────────────────────────────┘
```

**The Hardened Gate Standard:**

The wallet derives the tree to the hardened level (e.g., `m/352'/145'/0'/0'`) and exports only the xpub. The dapp receives the xpub and derives the final non-hardened `/0` child locally for ECDH, address generation, and stealth change derivation. The wallet never exposes a private key or unhardened parent key to the dapp.

* **Wallet Role (The Gate):** The wallet derives the tree to the hardened level (e.g., `m/352'/145'/0'/0'`) and exports only the **xpub**. This ensures the DApp never sees a private key or an unhardened parent key.
* **DApp Role (Final Derivation):** The DApp receives the xpub and is strictly responsible for deriving the final **non-hardened `/0` child** (e.g., `m/352'/145'/0'/0'/0`) locally for ECDH, prefix grinding, and address generation.

To ensure maximum security and isolation of the master seed, this standard defines strict roles:
 * Wallet (The Gate & Receiver): Derives to the hardened level (e.g., m/352'/145'/0'/0') and exports the xpub. It is solely responsible for scanning and receiving funds via input scanning or BCH pubkey indexer.
 * DApp (The Sender & Constructor): Receives the xpub and derives the final non-hardened /0 child locally. It utilizes these keys strictly for Sending Logic, including constructing transactions, deriving Stealth Change, and performing sender-side ECDH math.

**Handshake payload:**

```json
{
  "extensions": {
    "bch_stealth_bip352": {
      "spend_path": "m/352'/145'/0'/0'",
      "scan_path": "m/352'/145'/0'/1'"
    },
    "rpa_bip47": {
      "spend_path": "m/47'/145'/0'/0'",
      "scan_path": "m/47'/145'/0'/1'"
    }
  }
}
```

**Output payload mapping (paths array):**

```json
{
  "paths": [
    { "name": "receive",        "xpub": "..." },
    { "name": "change",         "xpub": "..." },
    { "name": "stealth_spend",  "xpub": "..." },
    { "name": "stealth_scan",   "xpub": "..." },
    { "name": "rpa_spend",      "xpub": "..." },
    { "name": "rpa_scan",       "xpub": "..." }
  ]
}
```

**Path reference:**

|Feature                   |Payload Key Name|Hardened Source Path|Final Working Key (DApp)|
|--------------------------|----------------|--------------------|------------------------|
|BCH Stealth Addresses     |`stealth_spend` |`m/352'/145'/0'/0'` |`.../0`                 |
|BCH Stealth Addresses     |`stealth_scan`  |`m/352'/145'/0'/1'` |`.../0`                 |
|Reusable Payment Addresses|`rpa_spend`     |`m/47'/145'/0'/0'`  |`.../0`                 |
|Reusable Payment Addresses|`rpa_scan`      |`m/47'/145'/0'/1'`  |`.../0`                 |

**Key design properties:**

- Wallet doesn’t need to know it’s constructing a stealth transaction — it just signs P2PKH
- No signMessage required — pure xpub approach, no signature malleability concerns
- Scan/spend isolation enforced by hardened gates — compromising one branch gives zero access to the other
- Same handshake supports both stealth addresses and RPA
- Hardware wallets (Ledger, Trezor) can sign stealth txs; scanning stays software side (same model as Monero)



-----

---
## SDK — `@BCHStealthProtocol/sdk`

The `sdk/` directory is the BCH Stealth Protocol JavaScript SDK.

```js
import { StealthKeys, Joiner, BCHPubkeyIndexer, WizConnect } from '@BCHStealthProtocol/sdk';
```

### Shared primitives

|Module      |Path                 |Description                                                               |
|------------|---------------------|--------------------------------------------------------------------------|
|`stealth`   |`sdk/src/stealth/`   |BIP352-style ECDH stealth addresses — send, scan, spend                   |
|`joiner`    |`sdk/src/joiner/`    |Silent CoinJoin / Fusion (Nostr-coordinated, 6-phase, NIP-59 gift-wrapped)|
|`indexer`   |`sdk/src/indexer/`   |BCHPubkeyIndexer HTTP client — privacy-preserving stealth scanning        |
|`wizconnect`|`sdk/src/wizconnect/`|WizardConnect — BCH dapp/wallet bridge (NIP-04)                           |
|`common`    |`sdk/src/common/`    |Crypto utility layer — CashAddr, BIP32, secp256k1, Nostr signing          |

> **Indexer:** any client (mobile or desktop) connects to a self-hosted or public indexer — same HTTP API either way.

These shared primitives are identical in [`@00-protocol/sdk`](https://github.com/00-Protocol/00-Protocol/tree/main/sdk).


--
## Roadmap

- [ ] Multi-round pipelining (outputs of round N → inputs of round N+1, automatic)
- [ ] Auto-mix on receive (trigger Fusion automatically on incoming UTXO)
- [ ] Tor transport for indexer queries

---

## Related

- **[00-Wallet](https://github.com/00-Protocol/00-Wallet)** — Browser wallet implementing this protocol
- **[@00-protocol/sdk](https://github.com/00-Protocol/sdk)** — NPM package for developers

---

## References
- BIP352 — Silent Payments (original spec): https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki
- BCH Reusable Payment Addresses spec: https://github.com/imaginaryusername/Reusable_specs/blob/master/reusable_addresses.md


---
## License
MIT
