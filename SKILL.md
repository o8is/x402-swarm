---
name: x402-swarm
description: Upload any file and get a public, shareable URL. Supports any file type up to 100MB on Swarm decentralized storage. Use when an agent needs to host files, publish a website, share images, or create a public link to any content. Payment is via USDC on Base through the x402 protocol. No accounts or API keys needed.
compatibility:
  requires:
    - curl
---

# x402 Swarm -- Decentralized File Hosting

Upload any file to Swarm decentralized storage and get a public URL. No accounts, no API keys. Payment is the auth.

## Quick reference

```bash
# 1. Pay and get an upload token (requires x402 payment via awal)
npx awal@latest x402 pay "https://x402.o8.is/prepare?duration=1d" -X POST --json

# Response:
# {"uploadToken": "a1b2c3...", "expiresAt": "..."}

# 2. Upload your files
curl -s -X POST "https://x402.o8.is/upload" \
  -F "uploadToken=YOUR_TOKEN" \
  -F "files=@index.html;type=text/html;filename=index.html"

# Response:
# {"urls": ["https://abc123.bzz.sh/index.html"], "expiresAt": "..."}
```

## Workflow

1. **Choose a duration**: 1 day (`1d`), 7 days (`7d`), or 14 days (`14d`).
2. **Get an upload token**: Call `POST https://x402.o8.is/prepare?duration=1d`. This is an x402-protected endpoint. Use `awal x402 pay` to handle payment automatically:
   ```bash
   npx awal@latest x402 pay "https://x402.o8.is/prepare?duration=1d" -X POST --json
   ```
   The response contains an `uploadToken` (valid for 10 minutes).
3. **Upload files**: Send a multipart POST to `/upload` with the token and your files:
   ```bash
   curl -s -X POST "https://x402.o8.is/upload" \
     -F "uploadToken=YOUR_TOKEN" \
     -F "files=@myfile.html;type=text/html;filename=myfile.html" \
     -F "files=@photo.jpg;type=image/jpeg;filename=photo.jpg"
   ```
4. **Use the URLs**: The response `urls` array contains public gateway links (e.g. `https://abc123.bzz.sh/myfile.html`). Embed or share them anywhere.

## Multiple files

You can upload multiple files in a single request. Each file gets its own URL under the same Swarm reference:

```bash
curl -s -X POST "https://x402.o8.is/upload" \
  -F "uploadToken=YOUR_TOKEN" \
  -F "files=@index.html;type=text/html;filename=index.html" \
  -F "files=@style.css;type=text/css;filename=style.css" \
  -F "files=@app.js;type=application/javascript;filename=app.js"
```

This is perfect for publishing a complete website.

## Constraints

- **Max size**: 100 MB per upload
- **Durations**: 1 day, 7 days, or 14 days
- **File types**: Any (HTML, JSON, images, CSS, JS, PDFs, etc.)
- **Token validity**: 10 minutes after purchase
- **Idempotent**: Safe to retry uploads on timeout
- **No auth required**: Payment is the only authentication

## Pricing

| Duration | Price (USDC) | Query param |
|----------|-------------|-------------|
| 1 Day    | $0.01       | `?duration=1d` |
| 7 Days   | $0.07       | `?duration=7d` |
| 14 Days  | $0.12       | `?duration=14d` |

Prices are in USDC on Base, paid automatically via the x402 protocol.

## Checking pricing programmatically

```bash
curl -s https://x402.o8.is/pricing
```

Returns the current pricing tiers and max upload size.

## API reference

Full OpenAPI docs are available at `https://x402.o8.is/docs`.

## Example: publish a website

```bash
# Generate an index.html (or use an existing one)
echo '<html><body><h1>Hello from Swarm!</h1></body></html>' > index.html

# Pay for 7 days of hosting
TOKEN=$(npx awal@latest x402 pay "https://x402.o8.is/prepare?duration=7d" -X POST --json | jq -r '.uploadToken')

# Upload
RESULT=$(curl -s -X POST "https://x402.o8.is/upload" \
  -F "uploadToken=$TOKEN" \
  -F "files=@index.html;type=text/html;filename=index.html")

echo "$RESULT" | jq -r '.urls[0]'
# https://abc123.bzz.sh/index.html
```

## Troubleshooting

- **Token expired**: Tokens are valid for 10 minutes. If expired, buy a new one with `/prepare`.
- **Upload too large**: Max 100 MB. Reduce file sizes or split into multiple uploads.
- **Payment failed**: Make sure your wallet is funded with USDC on Base. Run `npx awal@latest status` to check.
- **Timeout on upload**: The upload endpoint is idempotent. Retry with the same token safely.
