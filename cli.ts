#!/usr/bin/env npx tsx

import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const API_URL = process.env.API_URL || "http://localhost:4021";
console.log(`Using API_URL: ${API_URL}`);

const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY as `0x${string}`;

if (!TEST_PRIVATE_KEY) {
  console.error("Set TEST_PRIVATE_KEY env var with a funded Base Sepolia wallet");
  process.exit(1);
}

const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const httpClient = new x402HTTPClient(client);

async function fetchWithPayment(url: string, options: RequestInit = {}) {
  console.log(`Fetching ${url}...`);
  const res = await fetch(url, options);
  console.log(`Response status: ${res.status}`);

  if (res.status === 402) {
    const paymentRequired = httpClient.getPaymentRequiredResponse(name => res.headers.get(name));
    const payload = await httpClient.createPaymentPayload(paymentRequired);

    // Log payment details
    console.log("\nPayment Details:");
    console.log(`  Network: ${payload.accepted.network}`);
    console.log(`  Amount: ${payload.accepted.amount} ${payload.accepted.asset}`);
    console.log(`  Pay To: ${payload.accepted.payTo}`);

    // Debug: Log full payload to find the hash
    // console.log("Full payload:", JSON.stringify(payload, null, 2));

    if (payload.payload && payload.payload.hash) {
      console.log(`  Transaction Hash: ${payload.payload.hash}`);
    } else if (payload.data && payload.data.hash) {
      console.log(`  Transaction Hash: ${payload.data.hash}`);
    } else {
      console.log("  Transaction Hash: (Not found in payload)");
      console.log("  Payload keys:", Object.keys(payload));
      if (payload.payload) console.log("  payload.payload keys:", Object.keys(payload.payload));
    }

    const headers = httpClient.encodePaymentSignatureHeader(payload);

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        ...headers,
      },
    });
  }
  return res;
}

async function pricing() {
  const res = await fetch(`${API_URL}/pricing`);
  const data = await res.json();
  console.log("Pricing tiers:");
  console.table(data.tiers);
  console.log(`Max total size: ${data.maxTotalSize}`);
}

async function prepare(duration: string) {
  console.log(`\nPreparing upload for ${duration}...`);

  // Use client.fetch to automatically handle 402 Payment Required
  const res = await fetchWithPayment(`${API_URL}/prepare?duration=${duration}`, {
    method: "POST",
  });

  if (!res.ok) {
    console.error("Prepare failed:", await res.text());
    return;
  }

  const data = await res.json();
  console.log("Prepare successful!");
  console.log(`  Upload token: ${data.uploadToken}`);
  console.log(`  Ready at: ${data.readyAt}`);
  console.log(`  Expires at: ${data.expiresAt}`);

  return data;
}

async function upload(uploadToken: string, filePath: string) {
  console.log(`\nUploading ${filePath}...`);

  const fs = await import("fs");
  const path = await import("path");

  const fileContent = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append("uploadToken", uploadToken);
  formData.append("files", new Blob([fileContent]), fileName);

  const res = await fetch(`${API_URL}/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    console.error("Upload failed:", await res.text());
    return;
  }

  const data = await res.json();
  console.log("Upload successful!");
  console.log(`  URL: ${data.url}`);
  console.log(`  Reference: ${data.reference}`);
  console.log(`  CID: ${data.cid}`);
  console.log(`  Expires at: ${data.expiresAt}`);

  return data;
}

async function fullTest(duration: string, filePath: string) {
  // Step 1: Prepare
  const prepareResult = await prepare(duration);
  if (!prepareResult) return;

  // Step 2: Wait for stamp propagation
  const readyAt = new Date(prepareResult.readyAt);
  const waitMs = Math.max(0, readyAt.getTime() - Date.now());

  if (waitMs > 0) {
    console.log(`\nWaiting ${Math.ceil(waitMs / 1000)}s for stamp propagation...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  // Step 3: Upload
  await upload(prepareResult.uploadToken, filePath);
}

// CLI
const command = process.argv[2];

switch (command) {
  case "pricing":
    await pricing();
    break;

  case "prepare":
    const duration = process.argv[3] || "2d";
    await prepare(duration);
    break;

  case "upload":
    const token = process.argv[3];
    const file = process.argv[4];
    if (!token || !file) {
      console.error("Usage: cli.ts upload <token> <file>");
      process.exit(1);
    }
    await upload(token, file);
    break;

  case "test":
    const testDuration = process.argv[3] || "2d";
    const testFile = process.argv[4] || "README.md";
    await fullTest(testDuration, testFile);
    break;

  default:
    console.log(`
x402-swarm CLI

Usage:
  cli.ts pricing              Show pricing tiers
  cli.ts prepare <duration>   Prepare upload (2d, 7d, 30d)
  cli.ts upload <token> <file> Upload file with token
  cli.ts test <duration> <file> Full test (prepare + wait + upload)

Environment:
  API_URL          Server URL (default: http://localhost:4021)
  TEST_PRIVATE_KEY Private key for Base wallet (required)
`);
}
