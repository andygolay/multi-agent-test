# Multi-Agent Transaction Test

This test suite reproduces a multi-agent transaction workflow where:
1. First signer builds a multi-agent transaction (frontend)
2. Backend stores the serialized transaction
3. Second signer retrieves from backend and signs
4. Backend stores the signature (validates and re-encodes)
5. First signer retrieves transaction + signature from backend and submits

## Directory Structure

```
scripts/
├── repro-rust-backend/                         # Rust HTTP server for storage
├── repro-wallet-adapter-movement/              # Wallet adapter submission
└── repro-wallet-adapter-movement-client-submission/  # SDK client submission
```

## Rust Backend

The Rust backend stores and retrieves serialized transactions and signatures.

### What it does

**Transaction storage (`POST /transaction`):**
- Receives BCS hex from frontend
- Stores as-is (pass-through)
- Returns unchanged on retrieval

**Signature storage (`POST /signature`):**
1. Decodes hex to bytes
2. Validates by deserializing as `AccountAuthenticator`
3. Re-encodes to hex with `0x` prefix
4. Stores the validated signature

**Retrieval (`GET /transaction/:id`):**
- Returns transaction BCS hex (unchanged)
- Returns signature hex (if present)
- Returns timestamp

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/transaction` | POST | Store a serialized transaction |
| `/signature` | POST | Store and validate a signature |
| `/transaction/:id` | GET | Retrieve transaction and signature |

---

## Running the Tests

### Prerequisites

- Rust 1.70+
- Node.js 18+
- Nightly wallet browser extension (for wallet tests)

### Step 1: Start the Rust Backend

```bash
cd scripts/repro-rust-backend
cargo run
```

Wait for:
```
Server listening on 0.0.0.0:3001
```

### Step 2: Run a Test

**Option A: Wallet Adapter Submission**
```bash
cd scripts/repro-wallet-adapter-movement
npm install
npm run dev
# Open http://localhost:5173
```
Submits via `wallet.submitTransaction()`.

**Option B: SDK Client Submission**
```bash
cd scripts/repro-wallet-adapter-movement-client-submission
npm install
npm run dev
# Open http://localhost:5173
```
Submits via `movement.transaction.submit.multiAgent()`.

### Step 3: Follow the Wallet Test Flow

1. Connect first wallet (Nightly on Movement Testnet)
2. Click **Step 1: Create TX** - enter second signer's address
3. Switch to second wallet in Nightly
4. Click **Step 2: Sign**
5. Switch back to first wallet
6. Click **Step 3: Sign & Submit**

Watch logs for errors.

---

## Troubleshooting

### "Rust backend not reachable"
Make sure the backend is running on port 3001.

### "Module not found" when running npm
```bash
rm -rf node_modules package-lock.json
npm install
```
