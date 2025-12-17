/* eslint-disable jsdoc/require-jsdoc */
import { config } from "dotenv";
import express from "express";
import cors from "cors";
import multer from "multer";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import swaggerJsdoc from "swagger-jsdoc";
import { apiReference } from "@scalar/express-api-reference";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { StampedUploader } from "@hostasis/swarm-stamper";
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

const payTo = process.env.ADDRESS as `0x${string}`;

// Swarm configuration
const SWARM_GATEWAY = process.env.SWARM_GATEWAY || "https://swarm.o8.is";
const GNOSIS_RPC_URL = process.env.GNOSIS_RPC_URL || "https://rpc.gnosis.gateway.fm";

// Payment network configuration
const NETWORK_ENV = process.env.NETWORK || "base";
const PAYMENT_NETWORK = NETWORK_ENV.startsWith("eip155:")
  ? NETWORK_ENV
  : NETWORK_ENV === "base-sepolia"
    ? "eip155:84532"
    : "eip155:8453";

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
  transport: http(GNOSIS_RPC_URL),
});

const walletClient = createWalletClient({
  account: serverAccount,
  chain: gnosis,
  transport: http(GNOSIS_RPC_URL),
});

// Replay protection - track used nonces
const usedNonces = new Set<string>();
// Clean up every 5 minutes (tokens only valid 10 min anyway)
setInterval(() => usedNonces.clear(), 5 * 60 * 1000);

// Pricing tiers (in USD). ~3x margin over BZZ costs with volume discount
// Minimum 2 days due to Swarm's minimumInitialBalancePerChunk
const PRICING_TIERS = {
  "2d": { price: "0.01", hours: 48, days: 2 },
  "7d": { price: "0.03", hours: 24 * 7, days: 7 },
  "30d": { price: "0.10", hours: 24 * 30, days: 30 },
} as const;

type DurationTier = keyof typeof PRICING_TIERS;

// Token expiry time (10 minutes)
const TOKEN_EXPIRY_MS = 10 * 60 * 1000;
// Estimated stamp propagation time (2 minutes)
const STAMP_PROPAGATION_MS = 2 * 60 * 1000;

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
  // Add 20% buffer for price fluctuations
  const baseBalance = totalBlocks * pricePerChunkPerBlock;
  const bufferedBalance = baseBalance + (baseBalance * 20n) / 100n;
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
  const initialBalancePerChunk =
    calculatedBalance > minimumBalance ? calculatedBalance : minimumBalance;

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

  // Create batch
  console.log(`[${duration}] Creating batch...`);
  const hash = await walletClient.writeContract({
    address: POSTAGE_STAMP_ADDRESS,
    abi: PostageStampABI,
    functionName: "createBatch",
    args: [serverAccount.address, initialBalancePerChunk, depth, bucketDepth, nonce, true],
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
});

const app = express();
app.use(cors());

// Swagger Configuration
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "x402 Swarm Storage API",
      version: "1.0.0",
      description: "A decentralized storage service powered by Swarm and x402 payments.",
    },
    servers: [
      {
        url: "https://x402.o8.is",
        description: "Production Server",
      },
      {
        url: "http://localhost:4021",
        description: "Local Development",
      },
    ],
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "PAYMENT-SIGNATURE",
          description: "x402 Payment Signature Header (v2)",
        },
      },
    },
    security: [
      {
        x402: [],
      },
    ],
  },
  apis: ["./index.ts"], // Path to the API docs
};

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
// Strip the first line (header) from the README
const readmeBody = readme.split("\n").slice(1).join("\n");
swaggerOptions.definition.info.description = readmeBody;

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Serve Scalar API Reference at root
app.use(
  "/",
  apiReference({
    pageTitle: "x402 Swarm Storage",
    spec: {
      content: swaggerSpec,
    },
    hideDownloadButton: true,
    hideClientButton: true,
    hideDarkModeToggle: true,
    showDeveloperTools: "never",
    customCss: `
      .darklight-reference { display: none !important; }
    `,
  }),
);

// x402 Server Setup
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n");

const facilitatorConfig = createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET);
const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

const server = new x402ResourceServer(facilitatorClient);
server.register(PAYMENT_NETWORK, new ExactEvmScheme());

const routes = {
  "POST /prepare": {
    accepts: [
      {
        scheme: "exact",
        network: PAYMENT_NETWORK,
        payTo: payTo,
        price: async (context: any) => {
          const duration = context.adapter.getQueryParam("duration") as DurationTier;
          
          if (!duration || typeof duration !== 'string' || !PRICING_TIERS[duration]) {
            throw new Error("Invalid duration");
          }
          return PRICING_TIERS[duration].price;
        },
      }
    ],
    extensions: {
      ...declareDiscoveryExtension({
        name: "Swarm Storage Upload",
        description: "Purchase postage stamps and upload files to Swarm decentralized storage",
        input: {
          duration: "2d",
        },
        output: {
          success: true,
          uploadToken: "string",
          readyAt: "ISO Date",
          expiresAt: "ISO Date",
          duration: "2d",
        },
        tags: ["storage", "swarm", "upload", "web3"],
      }),
    },
  },
};

app.use(paymentMiddleware(routes, server));

/**
 * @openapi
 * /pricing:
 *   get:
 *     summary: Get available pricing tiers
 *     description: Returns the available duration tiers and their prices in USD.
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
 *                         example: "2d"
 *                       price:
 *                         type: string
 *                         example: "0.01"
 *                       duration:
 *                         type: string
 *                         example: "48 hours"
 *                 maxTotalSize:
 *                   type: string
 *                   example: "100MB"
 *                 serverWallet:
 *                   type: string
 *                   example: "0x..."
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
    serverWallet: serverAccount.address,
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
 *           enum: [2d, 7d, 30d]
 *         description: Duration of the storage (e.g., "2d" for 2 days)
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
 *                   example: "2d"
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
  const duration = req.query.duration as DurationTier;

  // Validate duration tier (redundant check but good for safety)
  if (!duration || !PRICING_TIERS[duration]) {
    res.status(400).json({
      error: "Invalid duration. Must be one of: 2d, 7d, 30d",
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
 *     description: Upload files to Swarm using a prepared upload token.
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
      error: "uploadToken is required in form data",
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

  // Check replay protection
  if (usedNonces.has(tokenData.nonce)) {
    res.status(401).json({
      error: "Upload token has already been used",
    });
    return;
  }

  // Mark nonce as used
  usedNonces.add(tokenData.nonce);

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

  try {
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

    // Return success response
    res.json({
      success: true,
      url: result.url,
      reference: result.reference,
      cid: result.cid,
      expiresAt,
      duration: tokenData.duration,
      filesUploaded: files.length,
    });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(500).json({
      error: "Upload failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:4021`);
});
