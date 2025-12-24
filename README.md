# x402 Swarm

Instantly turn any HTML, JSON, image or asset into a public, shareable link. Perfect for publishing AI inference responses, temporary visualizations, or one-off dashboards.

Powered by Swarm decentralized storage and x402 payments. Pay only for the duration you need.

**[Try the Demo →](https://x402.o8.is/drop)**

## How it works

We handle the complexity of buying Swarm postage stamps on Gnosis Chain and uploading stamped content to Swarm. You simply pay with USDC on Base, and we give you a public link to access your content.

### Usage Flow

1. **Prepare & Pay**: Call `/prepare` with your desired duration (`1d`, `7d`, or `14d`).
   - You will receive a `402 Payment Required` response.
   - Pay the requested amount in USDC on Base.
   - Once paid, you receive an `uploadToken`.

2. **Upload**: Use the `uploadToken` to post your files to `/upload`.
   - The token is valid for **10 minutes**.
   - **Max total upload size: 100MB**.
   - We handle the file chunking, stamping, and upload to the Swarm network.
   - You get back a public gateway URL (e.g., `https://{cid}.bzz.sh/{filename}`).

### Pricing & Durations

| Duration | Price (USDC) |
|----------|--------------|
| **1 Day**  | $0.04 |
| **7 Days** | $0.25 |
| **2 Weeks**| $0.50 |

*Prices include a small margin to cover BZZ volatility and hosting costs.*
