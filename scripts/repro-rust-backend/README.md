# Multi-Agent SEQUENCE_NUMBER_TOO_OLD Reproduction

This test reproduces a reported issue where multi-agent transactions fail with `SEQUENCE_NUMBER_TOO_OLD` on Movement but succeed on Aptos.

## Problem Description

In a multi-agent workflow:
1. First signer builds multi-agent transaction (frontend)
2. Backend saves the transaction
3. Second signer retrieves tx from backend and signs
4. Backend saves the signature
5. First signer retrieves tx from backend and submits
6. **Issue**: Fails on Movement with `SEQUENCE_NUMBER_TOO_OLD`, works on Aptos

## Architecture

```
┌─────────────────┐     POST /transaction      ┌─────────────────┐
│  First Signer   │ ─────────────────────────> │                 │
│  (TypeScript)   │                            │   Rust Backend  │
└─────────────────┘                            │   (Port 3001)   │
                                               │                 │
┌─────────────────┐     GET /transaction/:id   │  Stores:        │
│  Second Signer  │ <────────────────────────> │  - Transactions │
│  (TypeScript)   │     POST /signature        │  - Signatures   │
└─────────────────┘ ─────────────────────────> │                 │
                                               └─────────────────┘
┌─────────────────┐     GET /transaction/:id          │
│  First Signer   │ <─────────────────────────────────┘
│  (submits)      │
└─────────────────┘
```

## Prerequisites

- Rust 1.70+
- Node.js 18+
- npm

## Quick Start

### 1. Start the Rust Backend

```bash
cd scripts/repro-rust-backend
cargo run
```

You should see:
```
============================================
Multi-Agent Transaction Backend Server
============================================

MODE: PASS-THROUGH (store raw bytes, return unchanged)

Server listening on 0.0.0.0:3001
```

### 2. Run the TypeScript Test

In a new terminal:

```bash
cd scripts/repro-ts
npm install
npm run repro:both      # Test both Aptos devnet and Movement testnet
```

Other options:
```bash
npm run repro:aptos     # Test Aptos devnet only
npm run repro:movement  # Test Movement testnet only
```

## Backend Modes

### Pass-through Mode (Default)

Stores raw BCS bytes from TypeScript SDK and returns them unchanged.

```bash
cargo run
```

### Reserialize Mode

Deserializes transactions using the Rust SDK and re-serializes on retrieval. This tests if there are any BCS format differences between the TypeScript and Rust SDKs.

```bash
RESERIALIZE=1 cargo run
```

In this mode, the backend will log warnings if the BCS changes after re-serialization:
```
WARNING: BCS content changed after re-serialization!
```

## Expected Results

### If the bug is reproduced:
```
APTOS:
  Result: SUCCESS

MOVEMENT:
  Result: FAILED
  Error: SEQUENCE_NUMBER_TOO_OLD
```

### If both succeed:
The issue may require:
- Longer delays between steps
- Specific contract calls
- Wallet adapter interaction (use the React test instead)

## React/Wallet Adapter Test

For testing with actual wallet signatures:

### 1. Start the Rust Backend (same as above)

```bash
cd scripts/repro-rust-backend
cargo run
```

### 2. Start the React App

```bash
cd /tmp/multi-agent-example
npm run dev
```

### 3. Test Flow

1. Connect first wallet (Nightly)
2. Click "Step 1: Create TX" - enter second signer's address
3. Switch to second wallet
4. Click "Step 2: Sign"
5. Switch back to first wallet
6. Click "Step 3: Sign & Submit"

Watch for `SEQUENCE_NUMBER_TOO_OLD` errors in the logs.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/transaction` | POST | Store a serialized transaction |
| `/signature` | POST | Store a signature |
| `/transaction/:id` | GET | Retrieve transaction and signature |

### Request/Response Examples

**Store Transaction:**
```bash
curl -X POST http://localhost:3001/transaction \
  -H "Content-Type: application/json" \
  -d '{"transaction_id": "tx_123", "bcs_hex": "0x..."}'
```

**Store Signature:**
```bash
curl -X POST http://localhost:3001/signature \
  -H "Content-Type: application/json" \
  -d '{"transaction_id": "tx_123", "signature_hex": "0x..."}'
```

**Get Transaction:**
```bash
curl http://localhost:3001/transaction/tx_123
```

## Troubleshooting

### "Rust backend not reachable"
Make sure the Rust backend is running on port 3001.

### Faucet failures
The test uses direct HTTP faucet calls. If funding fails:
- Check network connectivity
- Try running with just one network: `npm run repro:movement`

### "Failed to fund" errors
Testnets may have rate limits. Wait a minute and try again.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Rust backend port |
| `RESERIALIZE` | `0` | Set to `1` to enable reserialize mode |
| `BACKEND_URL` | `http://localhost:3001` | TypeScript test backend URL |
