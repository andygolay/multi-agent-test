//! Rust backend server for multi-agent transaction reproduction test.
//!
//! This simulates a backend that stores and retrieves serialized transactions
//! to test if Rust SDK serialization causes SEQUENCE_NUMBER_TOO_OLD errors.
//!
//! There are two modes:
//! 1. Pass-through mode (default): Store raw BCS bytes, return unchanged
//! 2. Parse-reserialize mode: Deserialize with Rust SDK, re-serialize on retrieval
//!
//! Set RESERIALIZE=1 to enable parse-reserialize mode.

use aptos_sdk::aptos_bcs;
use aptos_sdk::transaction::types::MultiAgentRawTransaction;
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;

/// In-memory storage for transactions and signatures
struct AppState {
    /// Stored serialized transactions (key = transaction_id)
    transactions: Mutex<HashMap<String, StoredTransaction>>,
    /// Whether to deserialize/re-serialize using Rust SDK
    reserialize_mode: bool,
}

impl Default for AppState {
    fn default() -> Self {
        let reserialize = std::env::var("RESERIALIZE").map(|v| v == "1").unwrap_or(false);
        Self {
            transactions: Mutex::new(HashMap::new()),
            reserialize_mode: reserialize,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredTransaction {
    /// Raw BCS hex from TypeScript SDK
    raw_bcs_hex: String,
    /// Parsed sequence number (for debugging)
    sequence_number: Option<u64>,
    /// Secondary signer's signature (if provided)
    secondary_signature_hex: Option<String>,
    /// Timestamp when stored
    stored_at: u64,
}

#[derive(Deserialize)]
struct StoreTransactionRequest {
    transaction_id: String,
    bcs_hex: String,
}

#[derive(Serialize)]
struct StoreTransactionResponse {
    success: bool,
    transaction_id: String,
    sequence_number: Option<u64>,
    message: String,
}

#[derive(Deserialize)]
struct StoreSignatureRequest {
    transaction_id: String,
    signature_hex: String,
}

#[derive(Serialize)]
struct StoreSignatureResponse {
    success: bool,
    transaction_id: String,
    message: String,
}

#[derive(Serialize)]
struct GetTransactionResponse {
    success: bool,
    bcs_hex: Option<String>,
    secondary_signature_hex: Option<String>,
    sequence_number: Option<u64>,
    stored_at: Option<u64>,
    message: String,
}

/// Store a serialized transaction from the frontend
async fn store_transaction(
    State(state): State<Arc<AppState>>,
    Json(req): Json<StoreTransactionRequest>,
) -> (StatusCode, Json<StoreTransactionResponse>) {
    println!("\n[RUST BACKEND] Storing transaction: {}", req.transaction_id);
    println!("  BCS hex length: {} chars", req.bcs_hex.len());
    println!("  BCS hex prefix: {}...", &req.bcs_hex[..std::cmp::min(60, req.bcs_hex.len())]);

    // Try to parse and extract sequence number for debugging
    let sequence_number = parse_sequence_number(&req.bcs_hex);
    if let Some(seq) = sequence_number {
        println!("  Parsed sequence_number: {}", seq);
    }

    let stored = StoredTransaction {
        raw_bcs_hex: req.bcs_hex.clone(),
        sequence_number,
        secondary_signature_hex: None,
        stored_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    };

    let mut transactions = state.transactions.lock().unwrap();
    transactions.insert(req.transaction_id.clone(), stored);

    println!("  Transaction stored successfully");

    (
        StatusCode::OK,
        Json(StoreTransactionResponse {
            success: true,
            transaction_id: req.transaction_id,
            sequence_number,
            message: "Transaction stored".to_string(),
        }),
    )
}

/// Store a secondary signer's signature
async fn store_signature(
    State(state): State<Arc<AppState>>,
    Json(req): Json<StoreSignatureRequest>,
) -> (StatusCode, Json<StoreSignatureResponse>) {
    println!("\n[RUST BACKEND] Storing signature for: {}", req.transaction_id);
    println!("  Signature hex length: {} chars", req.signature_hex.len());
    println!(
        "  Signature hex prefix: {}...",
        &req.signature_hex[..std::cmp::min(60, req.signature_hex.len())]
    );

    let mut transactions = state.transactions.lock().unwrap();

    if let Some(tx) = transactions.get_mut(&req.transaction_id) {
        tx.secondary_signature_hex = Some(req.signature_hex);
        println!("  Signature stored successfully");
        (
            StatusCode::OK,
            Json(StoreSignatureResponse {
                success: true,
                transaction_id: req.transaction_id,
                message: "Signature stored".to_string(),
            }),
        )
    } else {
        println!("  ERROR: Transaction not found");
        (
            StatusCode::NOT_FOUND,
            Json(StoreSignatureResponse {
                success: false,
                transaction_id: req.transaction_id,
                message: "Transaction not found".to_string(),
            }),
        )
    }
}

/// Retrieve a transaction and its signature
async fn get_transaction(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(transaction_id): axum::extract::Path<String>,
) -> (StatusCode, Json<GetTransactionResponse>) {
    println!("\n[RUST BACKEND] Retrieving transaction: {}", transaction_id);
    println!("  Reserialize mode: {}", state.reserialize_mode);

    let transactions = state.transactions.lock().unwrap();

    if let Some(tx) = transactions.get(&transaction_id) {
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - tx.stored_at;

        println!("  Found! Stored {} seconds ago", elapsed);
        println!("  Sequence number: {:?}", tx.sequence_number);
        println!(
            "  Has secondary signature: {}",
            tx.secondary_signature_hex.is_some()
        );

        // Determine what BCS to return
        let bcs_hex_to_return = if state.reserialize_mode {
            // Try to deserialize with Rust SDK and re-serialize
            match try_reserialize(&tx.raw_bcs_hex) {
                Ok(reserialized) => {
                    let original_len = tx.raw_bcs_hex.len();
                    let new_len = reserialized.len();
                    if original_len != new_len {
                        println!("  WARNING: BCS length changed after re-serialization!");
                        println!("    Original: {} chars, Reserialized: {} chars", original_len, new_len);
                    }
                    if tx.raw_bcs_hex != reserialized {
                        println!("  WARNING: BCS content changed after re-serialization!");
                        println!("    Original: {}...", &tx.raw_bcs_hex[..std::cmp::min(60, tx.raw_bcs_hex.len())]);
                        println!("    Reserialized: {}...", &reserialized[..std::cmp::min(60, reserialized.len())]);
                    } else {
                        println!("  BCS unchanged after re-serialization (good!)");
                    }
                    reserialized
                }
                Err(e) => {
                    println!("  ERROR: Failed to re-serialize: {}", e);
                    println!("  Falling back to original BCS");
                    tx.raw_bcs_hex.clone()
                }
            }
        } else {
            tx.raw_bcs_hex.clone()
        };

        (
            StatusCode::OK,
            Json(GetTransactionResponse {
                success: true,
                bcs_hex: Some(bcs_hex_to_return),
                secondary_signature_hex: tx.secondary_signature_hex.clone(),
                sequence_number: tx.sequence_number,
                stored_at: Some(tx.stored_at),
                message: format!("Transaction retrieved (stored {} seconds ago)", elapsed),
            }),
        )
    } else {
        println!("  ERROR: Not found");
        (
            StatusCode::NOT_FOUND,
            Json(GetTransactionResponse {
                success: false,
                bcs_hex: None,
                secondary_signature_hex: None,
                sequence_number: None,
                stored_at: None,
                message: "Transaction not found".to_string(),
            }),
        )
    }
}

/// Try to deserialize and re-serialize using the Rust SDK
fn try_reserialize(bcs_hex: &str) -> Result<String, String> {
    // Remove 0x prefix if present
    let hex_str = bcs_hex.strip_prefix("0x").unwrap_or(bcs_hex);
    let has_prefix = bcs_hex.starts_with("0x");

    // Decode hex
    let bytes = hex::decode(hex_str).map_err(|e| format!("hex decode error: {}", e))?;

    // Try to deserialize as MultiAgentRawTransaction
    let multi_agent: MultiAgentRawTransaction =
        aptos_bcs::from_bytes(&bytes).map_err(|e| format!("BCS deserialize error: {}", e))?;

    println!("  Deserialized MultiAgentRawTransaction:");
    println!("    Sender: {:?}", multi_agent.raw_txn.sender);
    println!("    Sequence number: {}", multi_agent.raw_txn.sequence_number);
    println!(
        "    Secondary signers: {:?}",
        multi_agent.secondary_signer_addresses
    );

    // Re-serialize
    let reserialized_bytes =
        aptos_bcs::to_bytes(&multi_agent).map_err(|e| format!("BCS serialize error: {}", e))?;

    // Encode back to hex
    let reserialized_hex = if has_prefix {
        format!("0x{}", hex::encode(&reserialized_bytes))
    } else {
        hex::encode(&reserialized_bytes)
    };

    Ok(reserialized_hex)
}

/// Health check endpoint
async fn health() -> &'static str {
    "OK"
}

/// Try to parse the sequence number from a serialized MultiAgentTransaction
/// This is for debugging purposes only
fn parse_sequence_number(bcs_hex: &str) -> Option<u64> {
    // Remove 0x prefix if present
    let hex_str = bcs_hex.strip_prefix("0x").unwrap_or(bcs_hex);

    // Decode hex
    let bytes = hex::decode(hex_str).ok()?;

    // The MultiAgentTransaction BCS format is:
    // - RawTransaction (which starts with sender address, then sequence_number)
    // - Secondary signer addresses
    //
    // RawTransaction layout:
    // - sender: 32 bytes (AccountAddress)
    // - sequence_number: 8 bytes (u64, little-endian)
    // ... rest of transaction
    //
    // We need at least 40 bytes (32 for address + 8 for seq num)
    if bytes.len() < 40 {
        return None;
    }

    // Sequence number is at offset 32, 8 bytes, little-endian
    let seq_bytes: [u8; 8] = bytes[32..40].try_into().ok()?;
    Some(u64::from_le_bytes(seq_bytes))
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let state = Arc::new(AppState::default());

    println!("============================================");
    println!("Multi-Agent Transaction Backend Server");
    println!("============================================");
    println!();
    println!("This server stores and retrieves serialized transactions");
    println!("to test if Rust backend causes SEQUENCE_NUMBER issues.");
    println!();
    println!("MODE: {}", if state.reserialize_mode {
        "RESERIALIZE (deserialize with Rust SDK, re-serialize on retrieval)"
    } else {
        "PASS-THROUGH (store raw bytes, return unchanged)"
    });
    println!();
    println!("To enable reserialize mode: RESERIALIZE=1 cargo run");
    println!();
    println!("Endpoints:");
    println!("  POST /transaction     - Store a serialized transaction");
    println!("  POST /signature       - Store secondary signer's signature");
    println!("  GET  /transaction/:id - Retrieve transaction and signature");
    println!("  GET  /health          - Health check");
    println!();
    println!("Starting server on {}...", addr);
    println!();

    let app = Router::new()
        .route("/health", get(health))
        .route("/transaction", post(store_transaction))
        .route("/signature", post(store_signature))
        .route("/transaction/{transaction_id}", get(get_transaction))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Server listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}
