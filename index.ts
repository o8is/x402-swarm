/* eslint-disable jsdoc/require-jsdoc */
import { config } from "dotenv";
import express from "express";
import cors from "cors";
import multer from "multer";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { apiReference } from "@scalar/express-api-reference";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { StampedUploader } from "@hostasis/swarm-stamper";
import { buildSwaggerSpec } from "./swagger";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  keccak256,
  encodePacked,
  toBytes,
  maxUint256,
  erc20Abi,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { gnosis } from "viem/chains";

config();

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const payTo = process.env.ADDRESS as `0x${string}`;

// Swarm configuration
const SWARM_GATEWAY = process.env.SWARM_GATEWAY || "https://swarm.o8.is";
const GNOSIS_RPC_URL = process.env.GNOSIS_RPC_URL || "https://rpc.gnosis.gateway.fm";

// Payment network configuration
const NETWORK_ENV = process.env.NETWORK || "base";
const PAYMENT_NETWORK = (
  NETWORK_ENV.startsWith("eip155:")
    ? NETWORK_ENV
    : NETWORK_ENV === "base-sepolia"
      ? "eip155:84532"
      : "eip155:8453"
) as `${string}:${string}`;

// Gnosis Chain contract addresses
const BZZ_ADDRESS = "0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da" as const;
const POSTAGE_STAMP_ADDRESS = "0x45a1502382541Cd610CC9068e88727426b696293" as const;

// PostageStamp ABI (minimal)
const PostageStampABI = [
  {
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_initialBalancePerChunk", type: "uint256" },
      { name: "_depth", type: "uint8" },
      { name: "_bucketDepth", type: "uint8" },
      { name: "_nonce", type: "bytes32" },
      { name: "_immutable", type: "bool" },
    ],
    name: "createBatch",
    outputs: [{ type: "bytes32" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "lastPrice",
    outputs: [{ type: "uint64" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "minimumInitialBalancePerChunk",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "batchId", type: "bytes32" },
      { indexed: false, name: "totalAmount", type: "uint256" },
      { indexed: false, name: "normalisedBalance", type: "uint256" },
      { indexed: true, name: "owner", type: "address" },
      { indexed: false, name: "depth", type: "uint8" },
      { indexed: false, name: "bucketDepth", type: "uint8" },
      { indexed: false, name: "immutableFlag", type: "bool" },
    ],
    name: "BatchCreated",
    type: "event",
  },
] as const;

// Server secrets file for persistence across restarts
// Use /data for Docker/Akash (persistent volume), otherwise current directory
const DATA_DIR = existsSync("/data") ? "/data" : process.cwd();
const SECRETS_FILE = join(DATA_DIR, ".server-secrets");

interface ServerSecrets {
  privateKey: Hex;
  tokenSecret: string;
}

function loadOrCreateSecrets(): ServerSecrets {
  if (existsSync(SECRETS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SECRETS_FILE, "utf-8")) as ServerSecrets;
      console.log(`Loaded secrets from ${SECRETS_FILE}`);
      return data;
    } catch (e) {
      console.warn(`Failed to read ${SECRETS_FILE}, generating new secrets`);
    }
  }

  // Generate new secrets
  const secrets: ServerSecrets = {
    privateKey: generatePrivateKey(),
    tokenSecret: randomBytes(32).toString("hex"),
  };

  // Persist to file
  writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  console.log(`Generated and saved new secrets to ${SECRETS_FILE}`);

  return secrets;
}

const secrets = loadOrCreateSecrets();
const SERVER_PRIVATE_KEY = secrets.privateKey;
const TOKEN_SECRET = Buffer.from(secrets.tokenSecret, "hex");

const serverAccount = privateKeyToAccount(SERVER_PRIVATE_KEY);
console.log(`Server wallet: ${serverAccount.address}`);
console.log(`Payment network: ${PAYMENT_NETWORK}`);
console.log("Fund this wallet with xDAI (gas) and BZZ tokens on Gnosis Chain");

const publicClient = createPublicClient({
  chain: gnosis,
  transport: http(GNOSIS_RPC_URL, { timeout: 120_000 }),
});

const walletClient = createWalletClient({
  account: serverAccount,
  chain: gnosis,
  transport: http(GNOSIS_RPC_URL, { timeout: 120_000 }),
});

// Track in-flight and completed uploads for idempotent retries.
// When an agent's HTTP client times out mid-upload, it can re-submit the same
// token and either (a) await the still-running upload, (b) get the cached
// result, or (c) retry if the previous attempt failed.
interface UploadState {
  /** The promise resolving to the upload result (or rejection on failure) */
  promise: Promise<unknown>;
  /** Resolved result, cached for fast replay */
  result?: unknown;
  /** If the upload failed, store the error so the token can be retried */
  error?: unknown;
  /** Timestamp for cleanup */
  createdAt: number;
}

const uploadStates = new Map<string, UploadState>();

// Clean up finished upload states every 5 minutes (tokens only valid 10 min anyway)
setInterval(
  () => {
    const cutoff = Date.now() - TOKEN_EXPIRY_MS;
    for (const [nonce, state] of uploadStates) {
      if (state.createdAt < cutoff) {
        uploadStates.delete(nonce);
      }
    }
  },
  5 * 60 * 1000,
);

// Pricing tiers (in USD) with ~1.5x margin over BZZ costs
// At depth 19 (524k chunks) and BZZ ~$0.15:
//   1d  = 0.16 BZZ = $0.024 cost → $0.04 price
//   7d  = 1.14 BZZ = $0.17 cost  → $0.25 price
//   14d = 2.28 BZZ = $0.34 cost  → $0.50 price
const PRICING_TIERS = {
  "1d": { price: "0.04", hours: 24, days: 1 },
  "7d": { price: "0.25", hours: 24 * 7, days: 7 },
  "14d": { price: "0.50", hours: 24 * 14, days: 14 },
} as const;

type DurationTier = keyof typeof PRICING_TIERS;

// Token expiry time (10 minutes)
const TOKEN_EXPIRY_MS = 10 * 60 * 1000;
// Estimated stamp propagation time (1 minute)
const STAMP_PROPAGATION_MS = 1 * 60 * 1000;

// Gnosis chain: ~5 second blocks = ~17280 blocks per day
const BLOCKS_PER_DAY = 17280n;

if (!payTo) {
  console.error("Missing required environment variables:");
  if (!payTo) console.error("    ADDRESS is not set");
  process.exit(1);
}

// Upload token structure
interface UploadToken {
  batchId: string;
  depth: number;
  duration: DurationTier;
  nonce: string;
  expiry: number;
}

// Token encryption functions
function encryptToken(data: UploadToken): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TOKEN_SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function decryptToken(token: string): UploadToken | null {
  try {
    const data = Buffer.from(token, "base64url");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", TOKEN_SECRET, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
  } catch {
    return null;
  }
}

// Calculate initial balance per chunk for desired TTL
function calculateBalanceForTTL(ttlDays: number, pricePerChunkPerBlock: bigint): bigint {
  if (pricePerChunkPerBlock === 0n) {
    throw new Error("Price per chunk per block is zero");
  }
  const totalBlocks = BigInt(ttlDays) * BLOCKS_PER_DAY;
  // Add 10% buffer for price fluctuations (margin already covers most volatility)
  const baseBalance = totalBlocks * pricePerChunkPerBlock;
  const bufferedBalance = baseBalance + (baseBalance * 10n) / 100n;
  return bufferedBalance + 1n;
}

// Buy a postage stamp on Gnosis Chain
async function buyStamp(duration: DurationTier): Promise<{ batchId: string; depth: number }> {
  const tier = PRICING_TIERS[duration];
  const depth = 19; // ~112 MB effective capacity
  const bucketDepth = 16;

  // Get current price from contract
  const lastPrice = (await publicClient.readContract({
    address: POSTAGE_STAMP_ADDRESS,
    abi: PostageStampABI,
    functionName: "lastPrice",
  })) as bigint;

  // Get minimum balance requirement
  const minimumBalance = (await publicClient.readContract({
    address: POSTAGE_STAMP_ADDRESS,
    abi: PostageStampABI,
    functionName: "minimumInitialBalancePerChunk",
  })) as bigint;

  // Calculate balance for TTL
  const calculatedBalance = calculateBalanceForTTL(tier.days, lastPrice);
  // Use whichever is larger (calculateBalanceForTTL already includes a 10% buffer)
  const initialBalancePerChunk = calculatedBalance > minimumBalance ? calculatedBalance : minimumBalance;

  // Calculate total BZZ needed
  const totalBZZ = initialBalancePerChunk * (1n << BigInt(depth));
  console.log(`[${duration}] Creating stamp: ${totalBZZ} PLUR (${depth} depth, ${tier.days} days)`);

  // Check xDAI balance for gas
  const xdaiBalance = await publicClient.getBalance({ address: serverAccount.address });
  console.log(`Server xDAI Balance: ${xdaiBalance}`);
  if (xdaiBalance < 1000000000000000n) {
    // 0.001 xDAI
    console.warn("Warning: Low xDAI balance, transaction might fail due to gas");
  }

  // Check BZZ balance
  const bzzBalance = (await publicClient.readContract({
    address: BZZ_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [serverAccount.address],
  })) as bigint;
  console.log(`Server BZZ Balance: ${bzzBalance}`);

  if (bzzBalance < totalBZZ) {
    throw new Error(`Insufficient BZZ balance. Have ${bzzBalance}, need ${totalBZZ}`);
  }

  // Check and approve BZZ if needed
  const allowance = (await publicClient.readContract({
    address: BZZ_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [serverAccount.address, POSTAGE_STAMP_ADDRESS],
  })) as bigint;

  if (allowance < totalBZZ) {
    console.log(`[${duration}] Approving BZZ...`);
    const approveHash = await walletClient.writeContract({
      address: BZZ_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [POSTAGE_STAMP_ADDRESS, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  // Generate random nonce
  const nonce = keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [serverAccount.address, BigInt(Date.now()), BigInt(Math.floor(Math.random() * 1000000))],
    ),
  );

  // Create batch.
  const createBatchGas = 3_000_000n;
  console.log(
    `[${duration}] Creating batch (gas: ${createBatchGas}, balance: ${initialBalancePerChunk}, depth: ${depth}, bucketDepth: ${bucketDepth})...`,
  );

  // Dry-run to catch revert reasons before spending gas.
  try {
    await publicClient.simulateContract({
      account: serverAccount,
      address: POSTAGE_STAMP_ADDRESS,
      abi: PostageStampABI,
      functionName: "createBatch",
      args: [serverAccount.address, initialBalancePerChunk, depth, bucketDepth, nonce, true],
      gas: createBatchGas,
    });
  } catch (simErr: any) {
    const reason = simErr?.shortMessage || simErr?.message || String(simErr);
    console.error(`[${duration}] createBatch simulation failed:`, reason);
    throw new Error(`Batch creation would revert: ${reason}`);
  }

  const hash = await walletClient.writeContract({
    address: POSTAGE_STAMP_ADDRESS,
    abi: PostageStampABI,
    functionName: "createBatch",
    args: [serverAccount.address, initialBalancePerChunk, depth, bucketDepth, nonce, true],
    gas: createBatchGas,
  });

  // Wait for receipt and extract batch ID
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    throw new Error(`Batch creation failed: ${receipt.status}`);
  }

  // Extract batch ID from BatchCreated event
  const batchCreatedTopic = keccak256(
    toBytes("BatchCreated(bytes32,uint256,uint256,address,uint8,uint8,bool)"),
  );
  const batchCreatedEvent = receipt.logs.find(log => log.topics[0] === batchCreatedTopic);

  if (!batchCreatedEvent || !batchCreatedEvent.topics[1]) {
    throw new Error("BatchCreated event not found");
  }

  const batchId = batchCreatedEvent.topics[1] as Hex;
  console.log(`[${duration}] Batch created: ${batchId}`);

  return { batchId, depth };
}

// Upload limits
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB reported limit
const INTERNAL_MAX_SIZE = 112.06 * 1024 * 1024; // ~112MB theoretical limit for depth 19

// Multer for handling file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: INTERNAL_MAX_SIZE, // Allow up to theoretical max per file
  },
  preservePath: true, // Keep directory structure in filenames (e.g., "assets/image.png")
});

const app = express();
app.set("trust proxy", true);
app.use(cors());

const swaggerSpec = buildSwaggerSpec();

// x402 Server Setup
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  console.error("WARNING: CDP_API_KEY_ID or CDP_API_KEY_SECRET not set - payments will fail!");
} else {
  console.log(`CDP credentials loaded (key ID: ${CDP_API_KEY_ID.substring(0, 8)}...)`);
}

const facilitatorConfig = createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET);
const baseFacilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

// Store the last verification error for user-friendly messages
let lastVerifyError: string | null = null;

// Wrap facilitator client to capture errors for better UX
const facilitatorClient = {
  async verify(paymentPayload: any, paymentRequirements: any) {
    try {
      lastVerifyError = null;
      const price =
        paymentRequirements?.maxAmountRequired ?? paymentRequirements?.price ?? "unknown";
      const from =
        paymentPayload?.payload?.authorization?.from ?? paymentPayload?.from ?? "unknown";
      console.log(`[x402] VERIFY: from=${from}, price=${price}`);
      const result = await baseFacilitatorClient.verify(paymentPayload, paymentRequirements);
      console.log(`[x402] VERIFY SUCCESS: from=${from}, price=${price}`);
      return result;
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`[x402] VERIFY FAILED: ${errorMsg}`);
      // Extract user-friendly error message
      if (errorMsg.includes("insufficient_balance")) {
        lastVerifyError =
          "Insufficient USDC balance in your wallet. Please add USDC on Base to continue.";
      } else if (errorMsg.includes("invalid_signature")) {
        lastVerifyError = "Payment signature is invalid. Please try again.";
      } else if (errorMsg.includes("expired")) {
        lastVerifyError = "Payment authorization has expired. Please try again.";
      } else {
        lastVerifyError = `Payment verification failed: ${errorMsg}`;
      }
      throw err;
    }
  },
  async settle(paymentPayload: any, paymentRequirements: any) {
    const price = paymentRequirements?.maxAmountRequired ?? paymentRequirements?.price ?? "unknown";
    const from = paymentPayload?.payload?.authorization?.from ?? paymentPayload?.from ?? "unknown";
    console.log(`[x402] SETTLE: from=${from}, price=${price}`);
    try {
      const result = await baseFacilitatorClient.settle(paymentPayload, paymentRequirements);
      const txHash = result?.transaction ?? "no-tx";
      console.log(`[x402] SETTLE SUCCESS: from=${from}, price=${price}, tx=${txHash}`);
      return result;
    } catch (err: any) {
      console.error(
        `[x402] SETTLE FAILED: from=${from}, price=${price}, error=${err.message || err}`,
      );
      throw err;
    }
  },
  async getSupported() {
    return baseFacilitatorClient.getSupported();
  },
} as any;

const server = new x402ResourceServer(facilitatorClient);
server.register(PAYMENT_NETWORK, new ExactEvmScheme());

interface PriceContext {
  adapter: {
    getQueryParam: (key: string) => string | string[] | undefined;
  };
}

const prepareRoute = {
  accepts: [
    {
      scheme: "exact",
      network: PAYMENT_NETWORK,
      payTo: payTo,
      price: async (context: PriceContext) => {
        const durationParam = context.adapter.getQueryParam("duration");
        if (typeof durationParam === "string" && PRICING_TIERS[durationParam as DurationTier]) {
          return PRICING_TIERS[durationParam as DurationTier].price;
        }
        // Default to cheapest tier
        return PRICING_TIERS["1d"].price;
      },
    },
  ],
  extensions: {
    ...declareDiscoveryExtension({
      input: {
        duration: "1d",
      },
      output: {
        example: {
          success: true,
          uploadToken: "string",
          readyAt: "ISO Date",
          expiresAt: "ISO Date",
          duration: "1d",
        },
      },
    }),
  },
};

const routes = {
  "/prepare": prepareRoute,
};

// Wrap middleware to catch async errors.
const asyncMiddleware =
  (fn: express.RequestHandler) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error("[middleware error]", err);
      next(err);
    });
  };

// Debug middleware to log payment flow.
app.use((req, res, next) => {
  if (req.path === "/prepare") {
    const paymentHeader = req.headers["payment-signature"];
    console.log(`[/prepare] Method: ${req.method}, Has payment header: ${!!paymentHeader}`);
    if (paymentHeader) {
      // Decode and log partial payload for debugging.
      try {
        const decoded = JSON.parse(Buffer.from(paymentHeader as string, "base64").toString());
        console.log("[/prepare] Payment version:", decoded.x402Version);
        console.log("[/prepare] Accepted network:", decoded.accepted?.network);
        console.log("[/prepare] Accepted scheme:", decoded.accepted?.scheme);
      } catch (e) {
        console.log("[/prepare] Could not decode payment header");
      }
    }

    // Intercept response to inject error message for 402s.
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // If it's a 402 with empty body and we have a verify error, inject it.
      if (res.statusCode === 402 && lastVerifyError) {
        const enrichedBody = {
          ...body,
          error: lastVerifyError,
          code: "PAYMENT_VERIFICATION_FAILED",
        };
        console.log(
          `[/prepare] Response status: ${res.statusCode}, body:`,
          JSON.stringify(enrichedBody).substring(0, 300),
        );
        lastVerifyError = null; // Clear after use
        return originalJson(enrichedBody);
      }
      console.log(
        `[/prepare] Response status: ${res.statusCode}, body:`,
        JSON.stringify(body).substring(0, 200),
      );
      return originalJson(body);
    };
  }
  next();
});

app.use(asyncMiddleware(paymentMiddleware(routes as any, server)));

/**
 * @openapi
 * /pricing:
 *   get:
 *     summary: Get available pricing tiers
 *     description: Returns the available duration tiers and their prices in USD.
 *     security: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tiers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       tier:
 *                         type: string
 *                         example: "1d"
 *                       price:
 *                         type: string
 *                         example: "0.04"
 *                       duration:
 *                         type: string
 *                         example: "24 hours"
 *                 maxTotalSize:
 *                   type: string
 *                   example: "100MB"
 */
app.get("/pricing", (_req, res) => {
  const tiers = Object.entries(PRICING_TIERS).map(([tier, config]) => ({
    tier,
    price: config.price,
    duration: `${config.hours} hours`,
  }));

  res.json({
    tiers,
    maxTotalSize: "100MB",
  });
});

/**
 * @openapi
 * /prepare:
 *   post:
 *     summary: Prepare an upload
 *     description: Initiates the upload process by purchasing a postage stamp. Requires x402 payment.
 *     parameters:
 *       - in: query
 *         name: duration
 *         required: true
 *         schema:
 *           type: string
 *           enum: [1d, 7d, 14d]
 *         description: Duration of the storage (e.g., "1d" for 1 day)
 *     responses:
 *       200:
 *         description: Upload prepared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 uploadToken:
 *                   type: string
 *                   description: Encrypted token to use for the upload step
 *                 readyAt:
 *                   type: string
 *                   format: date-time
 *                   description: When the stamp will be ready (propagated)
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                   description: When the upload token expires
 *                 duration:
 *                   type: string
 *                   example: "1d"
 *       402:
 *         description: Payment Required
 *         headers:
 *           PAYMENT-REQUIRED:
 *             description: x402 Payment Request Header (v2)
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid duration
 */
app.post("/prepare", async (req, res) => {
  const duration = (req.query.duration as DurationTier) || "1d";

  // Validate duration tier
  if (!PRICING_TIERS[duration]) {
    const valid = Object.keys(PRICING_TIERS).join(", ");
    res.status(400).json({
      error: `Invalid duration. Must be one of: ${valid}`,
      availableTiers: Object.keys(PRICING_TIERS),
    });
    return;
  }

  try {
    // Buy stamp on Gnosis Chain
    const { batchId, depth } = await buyStamp(duration);

    // Generate nonce for replay protection
    const nonce = randomBytes(16).toString("hex");

    // Create encrypted token
    const now = Date.now();
    const tokenData: UploadToken = {
      batchId,
      depth,
      duration,
      nonce,
      expiry: now + TOKEN_EXPIRY_MS,
    };
    const uploadToken = encryptToken(tokenData);

    // Return token
    // Note: Payment settlement is handled automatically by the middleware when we send the response
    res.json({
      success: true,
      uploadToken,
      readyAt: new Date(now + STAMP_PROPAGATION_MS).toISOString(),
      expiresAt: new Date(now + TOKEN_EXPIRY_MS).toISOString(),
      duration,
      hint: "POST /upload is idempotent: if your request times out, re-POST with the same uploadToken and files to get the result. The server will resume or return the cached response.",
    });
  } catch (error) {
    console.error("Prepare failed:", error);
    res.status(500).json({
      error: "Failed to prepare upload",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * @openapi
 * /upload:
 *   post:
 *     summary: Upload files
 *     description: |
 *       Upload files to Swarm using a prepared upload token. Max total size is 100MB.
 *
 *       **Idempotent / retry-safe**: This endpoint is safe to call multiple times with the
 *       same `uploadToken`. If your request times out you can simply re-POST with the same
 *       token and files:
 *       - If the upload is **still in progress**, the server will wait and return the result
 *         once it finishes (no duplicate work).
 *       - If the upload **already succeeded**, the server returns the cached result instantly.
 *       - If the upload **previously failed**, the server allows a fresh retry.
 *
 *       The token remains valid until `expiresAt` (returned by `/prepare`), so you can
 *       safely retry for up to 10 minutes after preparation.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               uploadToken:
 *                 type: string
 *                 description: The token received from /prepare
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Files to upload (max 100MB total)
 *     responses:
 *       200:
 *         description: Upload successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 url:
 *                   type: string
 *                   description: Public gateway URL for the content
 *                 reference:
 *                   type: string
 *                   description: Swarm hash reference
 *                 cid:
 *                   type: string
 *                   description: CIDv1 representation
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                   description: When the content expires
 *                 filesUploaded:
 *                   type: integer
 *                   example: 1
 *       400:
 *         description: Bad request (missing token, files, or size limit exceeded)
 *       401:
 *         description: Invalid or expired token
 */
app.post("/upload", upload.array("files"), async (req, res) => {
  const uploadToken = req.body?.uploadToken as string;

  // Validate token presence
  if (!uploadToken) {
    res.status(400).json({
      error: "uploadToken is required. Call POST /prepare first to get one.",
      hint: "POST /prepare?duration=1d (payment required) → returns an uploadToken, then POST /upload with that token and your files.",
    });
    return;
  }

  // Decrypt and validate token
  const tokenData = decryptToken(uploadToken);
  if (!tokenData) {
    res.status(401).json({
      error: "Invalid or corrupted upload token",
    });
    return;
  }

  // Check token expiry
  if (Date.now() > tokenData.expiry) {
    res.status(401).json({
      error: "Upload token has expired",
    });
    return;
  }

  // Check if this nonce already has an in-flight or completed upload
  const existing = uploadStates.get(tokenData.nonce);
  if (existing) {
    // Previous attempt succeeded — return cached result immediately
    if (existing.result) {
      console.log(
        `[${tokenData.duration}] Returning cached upload result for nonce ${tokenData.nonce.substring(0, 8)}...`,
      );
      res.json(existing.result);
      return;
    }

    // Previous attempt failed — allow a fresh retry
    if (existing.error) {
      console.log(
        `[${tokenData.duration}] Previous upload failed, allowing retry for nonce ${tokenData.nonce.substring(0, 8)}...`,
      );
      uploadStates.delete(tokenData.nonce);
      // Fall through to re-process below
    } else {
      // Upload is still in progress — wait for it to finish
      console.log(
        `[${tokenData.duration}] Upload already in progress for nonce ${tokenData.nonce.substring(0, 8)}..., awaiting result`,
      );
      try {
        const result = await existing.promise;
        res.json(result);
      } catch (error) {
        console.error("In-flight upload failed:", error);
        res.status(500).json({
          error: "Upload failed",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
      return;
    }
  }

  // Validate files
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({
      error: "No files provided. Send files as multipart/form-data with field name 'files'",
    });
    return;
  }

  // Check total size
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    res.status(400).json({
      error: `Total upload size exceeds limit of 100MB (got ${(totalSize / 1024 / 1024).toFixed(2)}MB)`,
    });
    return;
  }

  // Perform the upload, tracked as a promise so concurrent/retry requests
  // can attach to the same in-flight operation.
  const uploadPromise = (async () => {
    // Convert multer files to File objects for swarm-stamper
    const swarmFiles = files.map(f => {
      const uint8Array = new Uint8Array(f.buffer);
      const blob = new Blob([uint8Array], { type: f.mimetype });
      return new File([blob], f.originalname, { type: f.mimetype });
    });

    // Create uploader instance using server wallet
    const uploader = new StampedUploader({
      gatewayUrl: SWARM_GATEWAY,
      batchId: tokenData.batchId,
      privateKey: SERVER_PRIVATE_KEY,
      depth: tokenData.depth,
      timeout: 120000, // 120s timeout for slow Swarm gateways
      retryAttempts: 10, // More retries for transient network errors
      concurrency: 20, // Lower concurrency to reduce connection pressure
    });

    // Upload to Swarm
    const result = await uploader.uploadFiles(swarmFiles, {
      onProgress: progress => {
        console.log(`[${tokenData.duration}] ${progress.phase}: ${progress.message}`);
      },
    });

    // Calculate content expiration based on stamp TTL
    const tier = PRICING_TIERS[tokenData.duration];
    const expiresAt = new Date(Date.now() + tier.hours * 60 * 60 * 1000).toISOString();

    return {
      success: true as const,
      url: result.url,
      reference: result.reference,
      cid: result.cid,
      expiresAt,
      duration: tokenData.duration,
      filesUploaded: files.length,
    };
  })();

  // Register in-flight upload BEFORE awaiting so concurrent requests can find it
  const state: UploadState = {
    promise: uploadPromise,
    createdAt: Date.now(),
  };
  uploadStates.set(tokenData.nonce, state);

  try {
    const result = await uploadPromise;
    state.result = result; // Cache for future retries
    res.json(result);
  } catch (error) {
    state.error = error; // Mark as failed so next retry can re-attempt
    console.error("Upload failed:", error);
    res.status(500).json({
      error: "Upload failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Serve UI page
app.get("/drop", (_req, res) => {
  res.sendFile(join(process.cwd(), "ui", "index.html"));
});

// Serve SKILL.md for agent discovery
app.get("/skill.md", (_req, res) => {
  res.type("text/markdown; charset=utf-8").sendFile(join(process.cwd(), "SKILL.md"));
});

// Serve static files before Scalar API Reference (so ui.js is served correctly)
app.use(express.static("public"));

// Serve landing page at root
app.get("/", (_req, res) => {
  res.sendFile(join(process.cwd(), "static", "landing.html"));
});

// Serve Scalar API Reference at /docs
app.get("/docs", (_req, res) => {
  const handler = apiReference({
    pageTitle: "x402 Swarm Storage",
    content: swaggerSpec,
    hideClientButton: true,
    showDeveloperTools: "never",
  } as any);
  handler(_req, res);
});

// Global error handler (Express requires all 4 params to detect error middleware)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof HttpError) {
    // Log client errors as warnings, not errors
    console.warn(`[${err.statusCode}] ${err.message}`);
    res.status(err.statusCode).json({
      error: err.message,
    });
    return;
  }

  console.error("Unhandled error:", err);

  res.status(500).json({
    error: err.message || "Internal Server Error",
    details: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:4021`);
});
