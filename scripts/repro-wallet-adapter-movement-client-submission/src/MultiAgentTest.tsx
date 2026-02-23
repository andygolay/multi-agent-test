import { useState } from "react";
import { useWallet } from "@moveindustries/wallet-adapter-react";
import {
  Movement,
  MovementConfig,
  Network,
  AccountAddress,
  U64,
  Deserializer,
  Hex,
  AccountAuthenticator,
  MultiAgentTransaction,
} from "@moveindustries/ts-sdk";

// Rust backend URL (update if running on different port)
const BACKEND_URL = "http://localhost:3001";

export function MultiAgentTest() {
  const {
    connect,
    disconnect,
    account,
    connected,
    wallet,
    signTransaction,
    submitTransaction,
  } = useWallet();

  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Transaction ID for backend storage
  const [transactionId, setTransactionId] = useState<string>("");
  const [secondSignerAddress, setSecondSignerAddress] = useState<string>("");

  // UI state (populated from backend)
  const [hasSavedTransaction, setHasSavedTransaction] = useState(false);
  const [hasSecondSignature, setHasSecondSignature] = useState(false);

  const log = (msg: string) => {
    console.log(msg);
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const clearLogs = () => setLogs([]);

  // Load the compiled script
  const loadScript = async () => {
    log("Loading transfer_two_by_two.mv script...");
    const response = await fetch("/transfer_two_by_two.mv");
    const buffer = await response.arrayBuffer();
    const bytecode = new Uint8Array(buffer);
    log(`Script loaded: ${bytecode.length} bytes`);
    return bytecode;
  };

  // STEP 1: First sender creates the transaction and saves to Rust backend
  const step1_CreateTransaction = async () => {
    if (!account) {
      log("ERROR: No account connected");
      return;
    }

    setLoading(true);
    clearLogs();

    try {
      log("=== STEP 1: Create Transaction (First Sender) ===");
      log(`Network: MOVEMENT TESTNET`);
      log(`First sender (you): ${account.address}`);

      const bytecode = await loadScript();

      const config = new MovementConfig({ network: Network.TESTNET });
      const movement = new Movement(config);

      // For this test, we'll use a placeholder for second signer
      const secondSignerAddr = prompt("Enter second signer address (0x...):");
      if (!secondSignerAddr) {
        log("ERROR: Second signer address required");
        return;
      }
      setSecondSignerAddress(secondSignerAddr);

      const amountFirst = 1000;
      const amountSecond = 1000;
      const dstFirst = AccountAddress.from(account.address);
      const dstSecond = AccountAddress.from(secondSignerAddr);
      const depositFirst = 1000;

      log("Building multi-agent transaction (5 min expiration)...");
      const transaction = await movement.transaction.build.multiAgent({
        sender: AccountAddress.from(account.address),
        secondarySignerAddresses: [AccountAddress.from(secondSignerAddr)],
        data: {
          bytecode,
          functionArguments: [
            new U64(amountFirst),
            new U64(amountSecond),
            dstFirst,
            dstSecond,
            new U64(depositFirst),
          ],
        },
        options: {
          expireTimestamp: Math.floor(Date.now() / 1000) + 300,
        },
      });

      // Serialize transaction
      const serializedTx = transaction.bcsToHex().toString();
      log(`Serialized TX: ${serializedTx.substring(0, 60)}...`);

      // Generate unique transaction ID
      const txId = `tx_movement_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setTransactionId(txId);

      // Save to Rust backend
      log(`Saving to Rust backend (ID: ${txId})...`);
      const response = await fetch(`${BACKEND_URL}/transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction_id: txId,
          bcs_hex: serializedTx,
        }),
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(`Backend error: ${result.message}`);
      }

      log(`Backend stored transaction.`);
      setHasSavedTransaction(true);
      log("");
      log("Now switch wallet to second signer and click Step 2");

    } catch (error: any) {
      log(`ERROR: ${error.message || error}`);
      console.error("Full error:", error);
    } finally {
      setLoading(false);
    }
  };

  // STEP 2: Second sender retrieves from backend, signs, and saves signature
  const step2_SecondSignerSign = async () => {
    if (!account) {
      log("ERROR: No account connected");
      return;
    }

    if (!transactionId) {
      log("ERROR: No transaction ID. Run Step 1 first.");
      return;
    }

    setLoading(true);

    try {
      log("=== STEP 2: Second Sender Signs ===");
      log(`Current wallet: ${account.address}`);

      // Retrieve transaction from Rust backend
      log(`Fetching transaction from backend (ID: ${transactionId})...`);
      const response = await fetch(`${BACKEND_URL}/transaction/${transactionId}`);
      const data = await response.json();

      if (!data.success || !data.bcs_hex) {
        throw new Error(`Backend error: ${data.message}`);
      }

      log(`Retrieved transaction (stored ${Math.floor((Date.now() / 1000) - (data.stored_at || 0))} seconds ago)`);

      // Deserialize transaction (received from Rust backend)
      const transaction = MultiAgentTransaction.deserialize(
        new Deserializer(Hex.fromHexString(data.bcs_hex).toUint8Array())
      );
      log("Transaction deserialized from backend data");

      // Sign with wallet adapter's signTransaction
      log("Requesting wallet signature...");
      const signature = await signTransaction({
        transactionOrPayload: transaction,
      });
      log("Wallet signed successfully");

      // Serialize the authenticator
      const authenticatorBcsHex = signature.authenticator.bcsToHex().toString();
      const authenticatorBcs = authenticatorBcsHex.startsWith('0x')
        ? authenticatorBcsHex
        : '0x' + authenticatorBcsHex;

      // Save signature to Rust backend
      log(`Saving signature to backend...`);
      const sigResponse = await fetch(`${BACKEND_URL}/signature`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction_id: transactionId,
          signature_hex: authenticatorBcs,
        }),
      });

      const sigResult = await sigResponse.json();
      if (!sigResult.success) {
        throw new Error(`Backend error: ${sigResult.message}`);
      }

      log("Signature saved to backend");
      setHasSecondSignature(true);
      log("");
      log("Now switch wallet back to first signer and click Step 3");

    } catch (error: any) {
      log(`ERROR: ${error.message || error}`);
      console.error("Full error:", error);
    } finally {
      setLoading(false);
    }
  };

  // STEP 3: First sender retrieves everything from backend, signs, and submits
  const step3_FirstSignerSubmit = async () => {
    if (!account) {
      log("ERROR: No account connected");
      return;
    }

    if (!transactionId) {
      log("ERROR: No transaction ID. Complete Steps 1 and 2 first.");
      return;
    }

    setLoading(true);

    try {
      log("=== STEP 3: First Sender Signs & Submits ===");
      log(`Current wallet: ${account.address}`);

      // Retrieve transaction and signature from Rust backend
      log(`Fetching transaction and signature from backend (ID: ${transactionId})...`);
      const response = await fetch(`${BACKEND_URL}/transaction/${transactionId}`);
      const data = await response.json();

      if (!data.success || !data.bcs_hex) {
        throw new Error(`Backend error: ${data.message}`);
      }

      if (!data.secondary_signature_hex) {
        throw new Error("Second signer's signature not found in backend");
      }

      const elapsedSeconds = Math.floor((Date.now() / 1000) - (data.stored_at || 0));
      log(`Retrieved from backend (stored ${elapsedSeconds} seconds ago)`);

      // Deserialize transaction (from Rust backend)
      const transaction = MultiAgentTransaction.deserialize(
        new Deserializer(Hex.fromHexString(data.bcs_hex).toUint8Array())
      );
      log("Transaction deserialized from backend");

      // Deserialize second signer's signature (from Rust backend)
      const signatureHex = data.secondary_signature_hex.startsWith('0x')
        ? data.secondary_signature_hex.slice(2)
        : data.secondary_signature_hex;

      const reviewerSignature = AccountAuthenticator.deserialize(
        new Deserializer(Hex.fromHexString(signatureHex).toUint8Array())
      );
      log("Second signer's signature deserialized from backend");

      // First sender signs with wallet (using wallet adapter)
      log("Requesting wallet signature...");
      const senderSignature = await signTransaction({
        transactionOrPayload: transaction,
      });
      log("Wallet signed successfully");

      // Submit to MOVEMENT TESTNET via SDK client (NOT wallet adapter)
      const config = new MovementConfig({ network: Network.TESTNET });
      const movement = new Movement(config);

      log("Submitting to MOVEMENT TESTNET via SDK client...");
      const pendingTx = await movement.transaction.submit.multiAgent({
        transaction,
        senderAuthenticator: senderSignature.authenticator,
        additionalSignersAuthenticators: [reviewerSignature],
      });

      log(`SUCCESS! Transaction hash: ${pendingTx.hash}`);

      log("Waiting for confirmation...");
      const result = await movement.waitForTransaction({
        transactionHash: pendingTx.hash,
      });
      log(`Transaction confirmed: ${result.success}`);

      // Reset state
      setTransactionId("");
      setHasSavedTransaction(false);
      setHasSecondSignature(false);

    } catch (error: any) {
      log(`ERROR: ${error.message || error}`);
      console.error("Full error:", error);

      // Check if it's a sequence number error
      const errorMsg = error.message || String(error);
      if (errorMsg.includes("SEQUENCE_NUMBER")) {
        log("");
        log(">>> SEQUENCE_NUMBER ERROR DETECTED <<<");
        log("This is the bug we're trying to reproduce!");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: "10px", padding: "10px", background: "#1a3a1a", borderRadius: "4px" }}>
        <strong>Network: MOVEMENT TESTNET (Client Submission)</strong>
        <br />
        <small style={{ color: "#8f8" }}>Submits via SDK client, NOT wallet adapter</small>
      </div>

      <div style={{ marginBottom: "10px", padding: "10px", background: "#2a2a2a", borderRadius: "4px" }}>
        <strong>Rust Backend:</strong> {BACKEND_URL}
        <br />
        <small style={{ color: "#888" }}>Make sure the Rust backend server is running!</small>
      </div>

      <div style={{ marginBottom: "20px" }}>
        {!connected ? (
          <button onClick={() => connect("Nightly")} style={{ padding: "10px 20px" }}>
            Connect Wallet
          </button>
        ) : (
          <div>
            <p>Connected: {account?.address?.toString().slice(0, 10)}...</p>
            <p>Wallet: {wallet?.name}</p>
            <button onClick={disconnect} style={{ padding: "5px 10px" }}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      {connected && (
        <div style={{ marginBottom: "20px" }}>
          <div style={{ marginBottom: "10px" }}>
            <button
              onClick={step1_CreateTransaction}
              disabled={loading}
              style={{ padding: "10px 20px", marginRight: "10px" }}
            >
              Step 1: Create TX (First Sender)
            </button>
          </div>
          <div style={{ marginBottom: "10px" }}>
            <button
              onClick={step2_SecondSignerSign}
              disabled={loading || !hasSavedTransaction}
              style={{ padding: "10px 20px", marginRight: "10px" }}
            >
              Step 2: Sign (Second Sender)
            </button>
          </div>
          <div style={{ marginBottom: "10px" }}>
            <button
              onClick={step3_FirstSignerSubmit}
              disabled={loading || !hasSecondSignature}
              style={{ padding: "10px 20px" }}
            >
              Step 3: Sign & Submit (First Sender)
            </button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: "10px", fontSize: "12px", color: "#888" }}>
        <p>Transaction ID: {transactionId || "(none)"}</p>
        <p>Backend has TX: {hasSavedTransaction ? "Yes" : "No"}</p>
        <p>Backend has 2nd Signature: {hasSecondSignature ? "Yes" : "No"}</p>
      </div>

      <div
        style={{
          background: "#1a1a1a",
          padding: "15px",
          borderRadius: "8px",
          maxHeight: "400px",
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
          <strong>Logs:</strong>
          <button onClick={clearLogs} style={{ padding: "2px 8px", fontSize: "12px" }}>
            Clear
          </button>
        </div>
        {logs.length === 0 ? (
          <p style={{ color: "#666" }}>No logs yet. Connect wallet and run the steps.</p>
        ) : (
          logs.map((l, i) => (
            <div
              key={i}
              style={{
                color: l.includes("ERROR") ? "#ff6b6b" : l.includes("SUCCESS") ? "#69db7c" : l.includes("WARNING") ? "#ffd43b" : "#ccc",
                fontSize: "13px",
                marginBottom: "4px",
              }}
            >
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
