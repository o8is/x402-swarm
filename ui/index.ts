import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { Address, createWalletClient, custom, getAddress, type EIP1193Provider  } from "viem";
import { base, baseSepolia } from "viem/chains";

const API_URL = window.location.origin;

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

// UI State
let account: string | null = null;
let walletClient: any = null;
let httpClient: x402HTTPClient | null = null;
let selectedFiles: File[] = [];
let selectedDuration = "1d";

// Elements
const dropZone = document.getElementById("dropZone")!;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const fileInfo = document.getElementById("fileInfo")!;
const fileName = document.getElementById("fileName")!;
const fileSize = document.getElementById("fileSize")!;
const durationSelector = document.getElementById("durationSelector")!;
const connectButton = document.getElementById("connectButton")!;
const uploadButton = document.getElementById("uploadButton") as HTMLButtonElement;
const progress = document.getElementById("progress")!;
const progressFill = document.getElementById("progressFill")!;
const progressText = document.getElementById("progressText")!;
const error = document.getElementById("error")!;
const result = document.getElementById("result")!;
const resultLink = document.getElementById("resultLink") as HTMLAnchorElement;
const copyButton = document.getElementById("copyButton")!;
const walletInfo = document.getElementById("walletInfo")!;
const maxSizeEl = document.getElementById("maxSize")!;

// Compute serve paths and common root strip (mirrors stamper behavior)
function computeServePaths(files: File[]) {
  let rootFolderToStrip = "";
  const firstRel =
    files.length > 0 ? ((files[0] as any).webkitRelativePath as string | undefined) : undefined;

  if (firstRel && firstRel.includes("/")) {
    const potentialRoot = firstRel.split("/")[0] + "/";
    const allHaveRoot = files.every(f => {
      const p = (f as any).webkitRelativePath as string | undefined;
      return p ? p.startsWith(potentialRoot) : false;
    });
    if (allHaveRoot) rootFolderToStrip = potentialRoot;
  }

  const entries = files.map(f => {
    const rel = (f as any).webkitRelativePath || null;
    let servePath = rel || f.name;
    if (rootFolderToStrip && rel && rel.startsWith(rootFolderToStrip)) {
      servePath = rel.slice(rootFolderToStrip.length);
    }
    return { name: f.name, rel, servePath, size: f.size };
  });

  return { entries, rootFolderToStrip };
}

// Allow picking folders and multiple files via the input
fileInput.setAttribute("multiple", "true");
fileInput.setAttribute("webkitdirectory", "true");
fileInput.setAttribute("directory", "true");

// Format bytes
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Show error
function showError(message: string) {
  error.textContent = message;
  error.classList.add("visible");
  setTimeout(() => error.classList.remove("visible"), 5000);
}

// Update progress
function updateProgress(percent: number, text: string) {
  progressFill.style.width = percent + "%";
  progressText.textContent = text;
}

// Load pricing from API
async function loadPricing() {
  try {
    const res = await fetch(`${API_URL}/pricing`);
    if (!res.ok) throw new Error("Failed to load pricing");
    const data = await res.json();

    if (data.tiers) {
      data.tiers.forEach((t: any) => {
        const priceEl = document.querySelector(`[data-price="${t.tier}"]`);
        if (priceEl) priceEl.textContent = `$${t.price}`;
      });
    }

    if (data.maxTotalSize) {
      maxSizeEl.textContent = `Max total upload: ${data.maxTotalSize}`;
    }
  } catch (err) {
    console.error("Pricing load failed", err);
    maxSizeEl.textContent = "Pricing unavailable";
  }
}

// Recursively collect files from DataTransferItemList (supports folder drops, preserves relative paths)
async function collectFilesFromItems(items: DataTransferItemList): Promise<File[]> {
  const readEntriesBatch = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  };

  const readAllEntries = async (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
    const all: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];
    do {
      batch = await readEntriesBatch(reader);
      all.push(...batch);
    } while (batch.length > 0);
    return all;
  };

  const traverseEntry = async (entry: FileSystemEntry, basePath = ""): Promise<File[]> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });

      const fullPath = `${basePath}${entry.name}`;
      const fileWithPath = new File([file], fullPath, {
        type: file.type,
        lastModified: file.lastModified,
      });
      // Store webkitRelativePath for consumers that rely on it
      Object.defineProperty(fileWithPath, "webkitRelativePath", {
        value: fullPath,
        writable: false,
      });
      return [fileWithPath];
    }

    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await readAllEntries(reader);
      const nested = await Promise.all(
        entries.map(e => traverseEntry(e, `${basePath}${entry.name}/`)),
      );
      return nested.flat();
    }

    return [];
  };

  const collected: File[] = [];
  for (const item of Array.from(items)) {
    const entry = item.webkitGetAsEntry?.();
    if (!entry) {
      const f = item.getAsFile();
      if (f) collected.push(f);
      continue;
    }
    const files = await traverseEntry(entry);
    collected.push(...files);
  }

  return collected;
}

// Handle file selection (files or collected folder contents)
function handleFiles(files: File[] | FileList) {
  const asArray = Array.isArray(files) ? files : Array.from(files);
  if (asArray.length === 0) return;

  const validFiles = asArray.filter(f => Number.isFinite(f.size));
  if (validFiles.length === 0) {
    showError("No valid files detected in selection");
    return;
  }

  selectedFiles = validFiles;
  const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

  if (totalSize > 100 * 1024 * 1024) {
    showError("Total size exceeds 100MB limit");
    return;
  }

  const { entries, rootFolderToStrip } = computeServePaths(selectedFiles);

  const displayName =
    selectedFiles.length === 1 ? entries[0].servePath : `${selectedFiles.length} files`;

  fileName.textContent = displayName;
  fileSize.textContent = formatBytes(totalSize);
  fileInfo.classList.add("visible");
  durationSelector.classList.add("visible");

  // Debug: log selected files with derived serve paths
  console.log(
    "selectedFiles",
    entries,
    "totalSize",
    totalSize,
    "rootFolderStrip",
    rootFolderToStrip || "(none)",
  );

  if (account) {
    uploadButton.style.display = "block";
  }

  result.classList.remove("visible");
}

// Drag and drop
dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", e => handleFiles((e.target as HTMLInputElement).files!));

let dragCounter = 0;
dropZone.addEventListener("dragenter", e => {
  e.preventDefault();
  dragCounter++;
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", e => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    dropZone.classList.remove("dragging");
  }
});

dropZone.addEventListener("dragover", e => e.preventDefault());

dropZone.addEventListener("drop", async e => {
  e.preventDefault();
  dragCounter = 0;
  dropZone.classList.remove("dragging");
  if (e.dataTransfer?.items?.length) {
    const collected = await collectFilesFromItems(e.dataTransfer.items);
    handleFiles(collected);
  } else if (e.dataTransfer?.files?.length) {
    handleFiles(e.dataTransfer.files);
  }
});

// Duration selection
document.querySelectorAll(".duration-option").forEach(option => {
  option.addEventListener("click", () => {
    document.querySelectorAll(".duration-option").forEach(o => o.classList.remove("selected"));
    option.classList.add("selected");
    selectedDuration = (option as HTMLElement).dataset.duration!;
  });
});

// Connect wallet
connectButton.addEventListener("click", async () => {
  try {
    if (!window.ethereum) {
      showError("No wallet detected.");
      return;
    }

    // Request account access
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];

    account = accounts[0];

    // Check network
    const chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    const chainIdInt = parseInt(chainId, 16);

    let networkName = "Unknown";
    if (chainIdInt === 8453) networkName = "Base";
    else if (chainIdInt === 84532) networkName = "Base Sepolia";
    else {
      showError("Please switch to Base or Base Sepolia network");
      return;
    }

    // Create viem wallet client using injected provider; normalize address to checksum
    const chain = chainIdInt === 8453 ? base : baseSepolia;
    const address = getAddress(account as `0x${string}`);
    walletClient = createWalletClient({
      chain,
      transport: custom(window.ethereum!),
      account: address,
    });

    // Initialize x402 client with signer providing address and signTypedData (as required by ExactEvmScheme)
    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: {
        address: address as Address,
        signTypedData: async (payload: any) => {
          return walletClient.signTypedData({
            account: address,
            domain: payload.domain,
            types: payload.types,
            primaryType: payload.primaryType,
            message: payload.message,
          });
        },
      },
    } as any);
    httpClient = new x402HTTPClient(client);

    walletInfo.textContent = `Connected: ${account.slice(0, 6)}...${account.slice(-4)} (${networkName})`;
    walletInfo.classList.add("visible");
    connectButton.style.display = "none";

    if (selectedFiles.length > 0) {
      uploadButton.style.display = "block";
    }
  } catch (err: unknown) {
    console.error("Wallet connection failed:", err);
    showError("Failed to connect wallet: " + (err instanceof Error ? err.message : String(err)));
  }
});

// Handle 402 payment flow using official x402 client
async function fetchWithPayment(url: string, options: RequestInit = {}) {
  const res = await fetch(url, options);

  if (res.status !== 402) {
    return res;
  }

  if (!httpClient) {
    throw new Error("Wallet not connected");
  }

  updateProgress(25, "Processing payment request...");

  try {
    // Get payment required from response headers
    const paymentRequired = httpClient.getPaymentRequiredResponse(name => res.headers.get(name));
    console.log("Payment Required:", paymentRequired);

    // Create payment payload using official client
    const payload = await httpClient.createPaymentPayload(paymentRequired);
    console.log("Payment Payload:", payload);

    updateProgress(40, "Requesting payment signature...");

    // Encode headers using official client
    const headers = httpClient.encodePaymentSignatureHeader(payload);
    console.log("Payment Headers:", headers);

    updateProgress(50, "Payment signed, processing...");

    // Retry with payment signature headers
    const retryRes = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        ...headers,
      },
    });

    if (retryRes.status === 402) {
      const bodyText = await retryRes.clone().text();
      console.error("Payment rejected. Response:", bodyText);
      throw new Error("Payment was rejected by server");
    }

    return retryRes;
  } catch (err: unknown) {
    console.error("Payment flow error:", err);
    throw err;
  }
}

// Upload flow
uploadButton.addEventListener("click", async () => {
  try {
    uploadButton.disabled = true;
    progress.classList.add("visible");
    result.classList.remove("visible");
    updateProgress(10, "Preparing upload...");

    // Debug: log files right before upload to ensure assets are present
    const uploadPaths = computeServePaths(selectedFiles);
    console.log(
      "upload start files",
      uploadPaths.entries,
      "count",
      selectedFiles.length,
      "rootFolderStrip",
      uploadPaths.rootFolderToStrip || "(none)",
    );

    // Step 1: Prepare (triggers 402 payment)
    const prepareRes = await fetchWithPayment(`${API_URL}/prepare?duration=${selectedDuration}`, {
      method: "POST",
    });

    if (!prepareRes.ok) {
      const errorData = await prepareRes.json();
      throw new Error(errorData.error || "Prepare failed");
    }

    const prepareData = await prepareRes.json();
    const { uploadToken, readyAt } = prepareData;

    updateProgress(60, "Stamp purchased, waiting for propagation...");

    // Step 2: Wait for stamp propagation
    const waitTime = Math.max(0, new Date(readyAt).getTime() - Date.now());
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    updateProgress(70, "Uploading files...");

    // Step 3: Upload files
    const formData = new FormData();
    formData.append("uploadToken", uploadToken);

    const { entries: uploadEntries } = computeServePaths(selectedFiles);
    selectedFiles.forEach((file, idx) => {
      const filename = uploadEntries[idx]?.servePath || file.name;
      formData.append("files", file, filename);
    });

    const uploadRes = await fetch(`${API_URL}/upload`, {
      method: "POST",
      body: formData,
    });

    if (!uploadRes.ok) {
      const errorData = await uploadRes.json();
      throw new Error(errorData.error || "Upload failed");
    }

    const uploadData = await uploadRes.json();

    updateProgress(100, "Complete!");

    // Show result
    resultLink.href = uploadData.url;
    resultLink.textContent = uploadData.url;
    result.classList.add("visible");

    // Reset for next upload
    selectedFiles = [];
    fileInfo.classList.remove("visible");
    durationSelector.classList.remove("visible");
    uploadButton.style.display = "none";
  } catch (err: unknown) {
    console.error("Upload failed:", err);
    if (err instanceof Error) {
      showError(err.message);
    } else {
      showError("An unknown error occurred");
    }
  } finally {
    uploadButton.disabled = false;
    setTimeout(() => progress.classList.remove("visible"), 2000);
  }
});

// Copy link
document.getElementById("copyButton")!.addEventListener("click", () => {
  navigator.clipboard.writeText(resultLink.href);
  copyButton.textContent = "✓ Copied!";
  setTimeout(() => (copyButton.textContent = "Copy Link"), 2000);
});

// Load pricing on init
loadPricing();
