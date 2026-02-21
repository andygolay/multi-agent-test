/**
 * Reproduction script for SEQUENCE_NUMBER_TOO_OLD issue
 *
 * Multi-agent workflow under test (matches developer's actual architecture):
 * 1. First signer builds multi-agent transaction (frontend)
 * 2. Backend (Rust) saves the transaction
 * 3. Second signer gets tx from backend and signs
 * 4. Backend (Rust) saves the signature
 * 5. First signer gets tx from backend and submits
 * 6. Issue: Fails on Movement with SEQUENCE_NUMBER_TOO_OLD, works on Aptos
 *
 * This test uses an actual Rust HTTP backend for storage/retrieval.
 * Start the backend with: cd ../repro-rust-backend && cargo run
 * For reserialize mode: cd ../repro-rust-backend && RESERIALIZE=1 cargo run
 */

import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  AccountAddress,
  U64,
  Deserializer,
  Hex,
  AccountAuthenticator,
  MultiAgentTransaction,
} from "@aptos-labs/ts-sdk";
import * as fs from "fs";
import * as path from "path";

// Rust backend URL
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

// Movement testnet config
const MOVEMENT_TESTNET = {
  fullnode: "https://testnet.movementnetwork.xyz/v1",
  faucet: "https://faucet.testnet.movementnetwork.xyz",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClient(network: "aptos" | "movement"): Aptos {
  if (network === "aptos") {
    return new Aptos(new AptosConfig({ network: Network.DEVNET }));
  } else {
    return new Aptos(
      new AptosConfig({
        fullnode: MOVEMENT_TESTNET.fullnode,
        faucet: MOVEMENT_TESTNET.faucet,
      })
    );
  }
}

function getFaucetUrl(network: "aptos" | "movement"): string {
  if (network === "aptos") {
    return "https://faucet.devnet.aptoslabs.com";
  } else {
    return MOVEMENT_TESTNET.faucet;
  }
}

async function checkBalance(aptos: Aptos, address: string): Promise<bigint> {
  try {
    const amount = await aptos.getAccountAPTAmount({ accountAddress: address });
    return BigInt(amount);
  } catch {
    try {
      const resources = await aptos.account.getAccountResources({ accountAddress: address });
      const coinResource = resources.find(
        (r) => r.type === "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>"
      );
      if (coinResource && (coinResource.data as any).coin?.value) {
        return BigInt((coinResource.data as any).coin.value);
      }
    } catch {
      // Account doesn't exist
    }
  }
  return BigInt(0);
}

async function fundViaHttp(
  faucetUrl: string,
  address: string,
  amount: number
): Promise<boolean> {
  try {
    const url = `${faucetUrl}/mint?amount=${amount}&address=${address}`;
    const response = await fetch(url, { method: "POST" });
    if (response.ok) {
      return true;
    }
    console.log(`  Faucet HTTP error: ${response.status} ${response.statusText}`);
    return false;
  } catch (e: any) {
    console.log(`  Faucet request failed: ${e.message}`);
    return false;
  }
}

async function fundWithRetry(
  aptos: Aptos,
  network: "aptos" | "movement",
  address: string,
  amount: number,
  maxRetries = 3
): Promise<boolean> {
  const minBalance = BigInt(1_000_000);
  const faucetUrl = getFaucetUrl(network);

  for (let i = 0; i < maxRetries; i++) {
    const currentBalance = await checkBalance(aptos, address);
    if (currentBalance >= minBalance) {
      console.log(`  Balance: ${currentBalance} (sufficient)`);
      return true;
    }

    console.log(`  Requesting funds from faucet (attempt ${i + 1}/${maxRetries})...`);
    await fundViaHttp(faucetUrl, address, amount);
    await sleep(5000);

    const newBalance = await checkBalance(aptos, address);
    if (newBalance >= minBalance) {
      console.log(`  Balance: ${newBalance} (funded successfully)`);
      return true;
    }
    console.log(`  Balance: ${newBalance} (insufficient, retrying...)`);
  }

  return false;
}

interface TestResult {
  network: string;
  test: string;
  success: boolean;
  error?: string;
  details?: Record<string, any>;
}

// Backend API functions
async function backendStoreTransaction(transactionId: string, bcsHex: string): Promise<{ success: boolean; sequence_number?: number; message: string }> {
  const response = await fetch(`${BACKEND_URL}/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_id: transactionId, bcs_hex: bcsHex }),
  });
  return response.json();
}

async function backendStoreSignature(transactionId: string, signatureHex: string): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${BACKEND_URL}/signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_id: transactionId, signature_hex: signatureHex }),
  });
  return response.json();
}

async function backendGetTransaction(transactionId: string): Promise<{
  success: boolean;
  bcs_hex?: string;
  secondary_signature_hex?: string;
  sequence_number?: number;
  stored_at?: number;
  message: string;
}> {
  const response = await fetch(`${BACKEND_URL}/transaction/${transactionId}`);
  return response.json();
}

async function checkBackendHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function loadScript(): Uint8Array {
  const scriptPath = path.join(import.meta.dirname, "transfer_two_by_two.mv");
  const buffer = fs.readFileSync(scriptPath);
  return new Uint8Array(buffer);
}

/**
 * Test the actual multi-agent workflow using Rust backend
 */
async function testMultiAgentWorkflow(network: "aptos" | "movement"): Promise<TestResult> {
  const testName = "multi-agent-workflow-with-rust-backend";
  console.log(`\n${"=".repeat(60)}`);
  const networkLabel = network === "aptos" ? "APTOS DEVNET" : "MOVEMENT TESTNET";
  console.log(`TEST: Multi-Agent Workflow on ${networkLabel}`);
  console.log(`Backend URL: ${BACKEND_URL}`);
  console.log("=".repeat(60));

  // Check backend health
  const backendHealthy = await checkBackendHealth();
  if (!backendHealthy) {
    return {
      network,
      test: testName,
      success: false,
      error: `Rust backend not reachable at ${BACKEND_URL}. Start it with: cd ../repro-rust-backend && cargo run`,
    };
  }
  console.log("Rust backend is healthy.");

  const aptos = getClient(network);

  // Two signers
  const firstSigner = Account.generate();
  const secondSigner = Account.generate();

  console.log(`\nFirst signer (sender):    ${firstSigner.accountAddress}`);
  console.log(`Second signer (secondary): ${secondSigner.accountAddress}`);

  // Fund both accounts
  console.log("\nFunding first signer...");
  const funded1 = await fundWithRetry(aptos, network, firstSigner.accountAddress.toString(), 100_000_000);
  if (!funded1) {
    return { network, test: testName, success: false, error: "Failed to fund first signer" };
  }

  console.log("\nFunding second signer...");
  const funded2 = await fundWithRetry(aptos, network, secondSigner.accountAddress.toString(), 100_000_000);
  if (!funded2) {
    return { network, test: testName, success: false, error: "Failed to fund second signer" };
  }

  // Load the Move script bytecode
  console.log("\nLoading Move script bytecode...");
  const bytecode = loadScript();
  console.log(`  Script loaded: ${bytecode.length} bytes`);

  // Get initial sequence number
  const initialInfo = await aptos.account.getAccountInfo({
    accountAddress: firstSigner.accountAddress,
  });
  console.log(`\nFirst signer initial sequence_number: ${initialInfo.sequence_number}`);

  // Generate transaction ID
  const transactionId = `tx_${network}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // =========================================================================
  // STEP 1: First signer builds multi-agent transaction
  // =========================================================================
  console.log("\n[STEP 1] First signer builds multi-agent transaction...");

  const multiAgentTx = await aptos.transaction.build.multiAgent({
    sender: firstSigner.accountAddress,
    secondarySignerAddresses: [secondSigner.accountAddress],
    data: {
      bytecode,
      functionArguments: [
        new U64(1000),
        new U64(1000),
        firstSigner.accountAddress,
        secondSigner.accountAddress,
        new U64(1000),
      ],
    },
    options: {
      expireTimestamp: Math.floor(Date.now() / 1000) + 300,
    },
  });

  const txSeqNum = multiAgentTx.rawTransaction.sequence_number.toString();
  console.log(`  Built with sequence_number: ${txSeqNum}`);

  // Serialize transaction
  const serializedTx = multiAgentTx.bcsToHex().toString();
  console.log(`  Serialized: ${serializedTx.substring(0, 60)}...`);

  // =========================================================================
  // STEP 2: Save to Rust backend
  // =========================================================================
  console.log("\n[STEP 2] Saving transaction to Rust backend...");
  const storeResult = await backendStoreTransaction(transactionId, serializedTx);
  if (!storeResult.success) {
    return { network, test: testName, success: false, error: `Backend store failed: ${storeResult.message}` };
  }
  console.log(`  Transaction stored (ID: ${transactionId})`);
  console.log(`  Backend parsed sequence_number: ${storeResult.sequence_number}`);

  // Simulate delay (like a real workflow)
  await sleep(1500);

  // =========================================================================
  // STEP 3: Second signer retrieves from backend and signs
  // =========================================================================
  console.log("\n[STEP 3] Second signer retrieves transaction from backend and signs...");

  const txData = await backendGetTransaction(transactionId);
  if (!txData.success || !txData.bcs_hex) {
    return { network, test: testName, success: false, error: `Backend get failed: ${txData.message}` };
  }
  console.log(`  Retrieved from backend`);
  console.log(`  Sequence number in tx: ${txData.sequence_number}`);

  // Check if BCS changed (if backend is in reserialize mode)
  if (txData.bcs_hex !== serializedTx) {
    console.log("  WARNING: BCS hex changed after backend storage/retrieval!");
    console.log(`  Original length: ${serializedTx.length}, Retrieved length: ${txData.bcs_hex.length}`);
  }

  // Deserialize (from Rust backend)
  const deserializedTx = MultiAgentTransaction.deserialize(
    new Deserializer(Hex.fromHexString(txData.bcs_hex).toUint8Array())
  );

  const secondarySignerAuth = aptos.transaction.sign({
    signer: secondSigner,
    transaction: deserializedTx,
  });
  console.log("  Second signer signed.");

  // Serialize signature
  const serializedSig = secondarySignerAuth.bcsToHex().toString();
  console.log(`  Serialized signature: ${serializedSig.substring(0, 60)}...`);

  // =========================================================================
  // STEP 4: Save signature to Rust backend
  // =========================================================================
  console.log("\n[STEP 4] Saving second signer's signature to Rust backend...");
  const sigResult = await backendStoreSignature(transactionId, serializedSig);
  if (!sigResult.success) {
    return { network, test: testName, success: false, error: `Backend sig store failed: ${sigResult.message}` };
  }
  console.log("  Signature stored in backend.");

  // Simulate delay
  await sleep(1500);

  // =========================================================================
  // STEP 5: First signer retrieves everything from backend and submits
  // =========================================================================
  console.log("\n[STEP 5] First signer retrieves transaction and signature from backend...");

  const finalData = await backendGetTransaction(transactionId);
  if (!finalData.success || !finalData.bcs_hex || !finalData.secondary_signature_hex) {
    return { network, test: testName, success: false, error: `Backend get failed: ${finalData.message}` };
  }

  const elapsedSecs = Math.floor(Date.now() / 1000) - (finalData.stored_at || 0);
  console.log(`  Retrieved from backend (stored ${elapsedSecs} seconds ago)`);
  console.log(`  Sequence number in tx: ${finalData.sequence_number}`);

  // Deserialize transaction and signature (from Rust backend)
  const finalTx = MultiAgentTransaction.deserialize(
    new Deserializer(Hex.fromHexString(finalData.bcs_hex).toUint8Array())
  );

  const deserializedSecondSig = AccountAuthenticator.deserialize(
    new Deserializer(Hex.fromHexString(finalData.secondary_signature_hex).toUint8Array())
  );

  // Check current sequence number
  const currentInfo = await aptos.account.getAccountInfo({
    accountAddress: firstSigner.accountAddress,
  });
  console.log(`\n  On-chain sequence_number NOW: ${currentInfo.sequence_number}`);
  console.log(`  Transaction sequence_number:  ${txSeqNum}`);

  const match = currentInfo.sequence_number === txSeqNum;
  console.log(`  Match: ${match ? "YES" : "NO - POTENTIALLY STALE"}`);

  // First signer signs
  console.log("\n  First signer signing...");
  const primarySignerAuth = aptos.transaction.sign({
    signer: firstSigner,
    transaction: finalTx,
  });

  // Submit as multi-agent
  console.log("  Submitting multi-agent transaction...");
  try {
    const pendingTx = await aptos.transaction.submit.multiAgent({
      transaction: finalTx,
      senderAuthenticator: primarySignerAuth,
      additionalSignersAuthenticators: [deserializedSecondSig],
    });

    console.log(`  Submitted: ${pendingTx.hash}`);

    const result = await aptos.waitForTransaction({
      transactionHash: pendingTx.hash,
      options: { timeoutSecs: 30 },
    });

    console.log(`\nSUCCESS! Transaction confirmed.`);
    return {
      network,
      test: testName,
      success: true,
      details: { txHash: pendingTx.hash },
    };
  } catch (e: any) {
    const errorMsg = e.message || String(e);
    console.log(`\nFAILED:`);
    console.log(errorMsg);

    const isSeqNumError =
      errorMsg.includes("SEQUENCE_NUMBER_TOO_OLD") ||
      errorMsg.includes("sequence_number") ||
      errorMsg.includes("SEQUENCE_NUMBER");

    return {
      network,
      test: testName,
      success: false,
      error: errorMsg,
      details: {
        seqNumAtBuild: txSeqNum,
        seqNumAtSubmit: currentInfo.sequence_number,
        isSequenceNumberError: isSeqNumError,
        usedRustBackend: true,
      },
    };
  }
}

async function compareBothNetworks() {
  console.log("\n" + "#".repeat(60));
  console.log("COMPARING APTOS vs MOVEMENT - Multi-Agent Workflow");
  console.log("Using Rust backend for transaction storage/retrieval");
  console.log("#".repeat(60));

  const results: TestResult[] = [];

  // Run on Aptos
  try {
    results.push(await testMultiAgentWorkflow("aptos"));
  } catch (e: any) {
    results.push({
      network: "aptos",
      test: "multi-agent-workflow",
      success: false,
      error: e.message,
    });
  }

  // Run on Movement
  try {
    results.push(await testMultiAgentWorkflow("movement"));
  } catch (e: any) {
    results.push({
      network: "movement",
      test: "multi-agent-workflow",
      success: false,
      error: e.message,
    });
  }

  // Print results
  console.log("\n" + "#".repeat(60));
  console.log("RESULTS SUMMARY");
  console.log("#".repeat(60));

  for (const r of results) {
    console.log(`\n${r.network.toUpperCase()}:`);
    console.log(`  Test: ${r.test}`);
    console.log(`  Result: ${r.success ? "SUCCESS" : "FAILED"}`);
    if (r.error) {
      console.log(`  Error: ${r.error}`);
    }
    if (r.details) {
      console.log(`  Details: ${JSON.stringify(r.details)}`);
    }
  }

  // Analysis
  console.log("\n" + "-".repeat(50));
  console.log("ANALYSIS:");
  console.log("-".repeat(50));

  const aptosResult = results.find((r) => r.network === "aptos");
  const movementResult = results.find((r) => r.network === "movement");

  if (aptosResult && movementResult) {
    if (aptosResult.success && !movementResult.success) {
      console.log("\n>>> KEY FINDING: Aptos SUCCEEDED, Movement FAILED <<<");
      console.log("\nThis reproduces the reported behavior!");

      if (movementResult.details?.isSequenceNumberError) {
        console.log("\nMovement failed with SEQUENCE_NUMBER error.");
        console.log("This confirms Movement handles sequence numbers differently.");
      }
    } else if (!aptosResult.success && !movementResult.success) {
      console.log("\nBoth networks failed. Checking error types...");
      console.log(`\nAptos error: ${aptosResult.error}`);
      console.log(`\nMovement error: ${movementResult.error}`);
    } else if (aptosResult.success && movementResult.success) {
      console.log("\nBoth networks succeeded.");
      console.log("The issue may require specific conditions not reproduced here.");
      console.log("\nTry running with RESERIALIZE=1 on the Rust backend to test");
      console.log("if Rust SDK serialization causes issues.");
    } else {
      console.log("\nUnexpected: Movement succeeded but Aptos failed.");
    }
  }
}

async function main() {
  const arg = process.argv[2] || "both";

  console.log("+----------------------------------------------------------+");
  console.log("|  Multi-Agent SEQUENCE_NUMBER_TOO_OLD Reproduction        |");
  console.log("|  Using Rust Backend for Storage/Retrieval                |");
  console.log("+----------------------------------------------------------+");
  console.log("\nWorkflow being tested:");
  console.log("  1. First signer builds multi-agent tx (TypeScript SDK)");
  console.log("  2. POST serialized tx to Rust backend");
  console.log("  3. Second signer GETs tx from Rust backend, signs");
  console.log("  4. POST signature to Rust backend");
  console.log("  5. First signer GETs tx+sig from Rust backend, signs, submits");
  console.log("");
  console.log(`Rust Backend URL: ${BACKEND_URL}`);
  console.log("");

  if (arg === "both") {
    await compareBothNetworks();
  } else if (arg === "aptos" || arg === "movement") {
    await testMultiAgentWorkflow(arg);
  } else {
    console.log(`Unknown argument: ${arg}`);
    console.log("\nUsage:");
    console.log("  npm run repro:both      # Compare both networks");
    console.log("  npm run repro:movement  # Movement only");
    console.log("  npm run repro:aptos     # Aptos only");
    console.log("\nMake sure Rust backend is running:");
    console.log("  cd ../repro-rust-backend && cargo run");
    console.log("\nFor reserialize mode (tests Rust SDK serialization):");
    console.log("  cd ../repro-rust-backend && RESERIALIZE=1 cargo run");
    process.exit(1);
  }
}

main().catch(console.error);
