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

## Directory Structure

```
scripts/
├── repro-rust-backend/    # Rust HTTP server (required for both tests)
├── repro-ts/              # Automated TypeScript test (no wallet needed)
└── repro-wallet-adapter/  # React app with wallet adapter (manual test)
```

## Prerequisites

- Rust 1.70+
- Node.js 18+
- npm
- (For wallet test) Nightly wallet browser extension

---

## Option 1: Automated TypeScript Test

This test runs automatically with generated accounts - no wallet needed.

### Step 1: Start the Rust Backend

```bash
cd scripts/repro-rust-backend
cargo run
```

Wait until you see:
```
Server listening on 0.0.0.0:3001
```

### Step 2: Run the Test

In a **new terminal**:

```bash
cd scripts/repro-ts
npm install
npm run repro:both
```

This tests both Aptos devnet and Movement testnet automatically.

**Other options:**
```bash
npm run repro:aptos     # Test Aptos devnet only
npm run repro:movement  # Test Movement testnet only
```

---

## Option 2: Wallet Adapter Test (Manual)

This test uses real wallet signatures - closer to the actual developer workflow.

### Step 1: Start the Rust Backend

```bash
cd scripts/repro-rust-backend
cargo run
```

### Step 2: Start the React App

In a **new terminal**:

```bash
cd scripts/repro-wallet-adapter
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

### Step 3: Run the Test

1. **Connect first wallet** (Nightly) - this is the "first signer"
2. Click **"Step 1: Create TX"**
   - Enter the second signer's address when prompted
3. **Switch to second wallet** in Nightly
4. Click **"Step 2: Sign"**
5. **Switch back to first wallet**
6. Click **"Step 3: Sign & Submit"**

Watch the logs for `SEQUENCE_NUMBER_TOO_OLD` errors.

---

## Architecture

```
┌─────────────────┐     POST /transaction      ┌─────────────────┐
│  First Signer   │ ─────────────────────────> │                 │
│  (Frontend)     │                            │   Rust Backend  │
└─────────────────┘                            │   (Port 3001)   │
                                               │                 │
┌─────────────────┐     GET /transaction/:id   │  Stores:        │
│  Second Signer  │ <────────────────────────> │  - Transactions │
│  (Frontend)     │     POST /signature        │  - Signatures   │
└─────────────────┘ ─────────────────────────> │                 │
                                               └─────────────────┘
┌─────────────────┐     GET /transaction/:id          │
│  First Signer   │ <─────────────────────────────────┘
│  (submits)      │
└─────────────────┘
```

---

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
The issue may require specific conditions not reproduced here.

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/transaction` | POST | Store a serialized transaction |
| `/signature` | POST | Store a signature |
| `/transaction/:id` | GET | Retrieve transaction and signature |

---

## Troubleshooting

### "Rust backend not reachable"
Make sure the Rust backend is running on port 3001 in another terminal.

### Faucet failures
The test uses direct HTTP faucet calls. If funding fails:
- Check network connectivity
- Wait a minute (rate limits)
- Try running with just one network: `npm run repro:movement`

### Wallet adapter test not loading
Make sure you ran `npm install` in the `repro-wallet-adapter` directory.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Rust backend port |
| `BACKEND_URL` | `http://localhost:3001` | TypeScript test backend URL |
