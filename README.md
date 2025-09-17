# Pixie

Self-hosted email read-receipt tracking pixel powered by Cloudflare Workers and KV.

## Features

- Generate unique tracking pixel URLs using a simple authenticated API endpoint.
- Serve a 1×1 transparent GIF and log opens with timestamp, coarse IP, user agent, language, and geo metadata.
- Retrieve event logs as JSON or CSV through a tokenized endpoint.
- Cloudflare Workers KV storage keeps the solution fully serverless on the free tier.

## Architecture

| Component | Responsibility |
| --- | --- |
| Cloudflare Worker (`src/index.ts`) | Handles API requests, serves the pixel, records events, and returns reports. |
| Cloudflare KV (`PIXIE_STORE`) | Persists pixel metadata and individual open events. |
| API key secret (`API_KEY`) | Protects the pixel-creation endpoint; generated pixels embed a per-link access token for report retrieval. |

Each tracking pixel is identified by a random hex string. Metadata and events are stored separately so that individual opens can be retrieved without overwriting prior data. When the Worker serves the pixel, it appends a new event entry and updates basic counters in metadata.

## Prerequisites

- Cloudflare account with Workers and KV enabled (both available on the free tier).
- Wrangler CLI (`npm install -g wrangler` or use `npx wrangler`).
- A long random string to use as the Worker API key for creating new pixel records.

## Local Setup

```bash
cd ~/git/pixie
npm install
npm run dev
```

`npm run dev` starts Wrangler in local mode; configure `PIXIE_STORE` using Wrangler's prompts or add a `wrangler.toml.local` that points to a KV preview namespace.

## Deploying to Cloudflare

1. Create a KV namespace for production and preview:

   ```bash
   wrangler kv:namespace create PIXIE_STORE
   wrangler kv:namespace create PIXIE_STORE --preview
   ```

   Copy the generated IDs into `wrangler.toml`.

2. Push the API key secret:

   ```bash
   wrangler secret put API_KEY
   ```

3. Deploy the Worker:

   ```bash
   npm run deploy
   ```

   Wrangler outputs the public Worker URL—for example `https://pixie.example.workers.dev`.

## Creating a Tracking Pixel

Send an authenticated request to `/api/pixels` using the API key you stored as a secret.

```bash
curl -X POST "https://pixie.example.workers.dev/api/pixels" \
  -H "x-api-key: $PIXIE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"label":"Quarterly update","metadata":{"campaign":"q4"}}'
```

Sample response:

```json
{
  "id": "4f9e2a6d8b71",
  "createdAt": "2025-09-17T18:00:00.000Z",
  "pixelUrl": "https://pixie.example.workers.dev/pixel/4f9e2a6d8b71.gif",
  "eventsUrl": "https://pixie.example.workers.dev/api/pixels/4f9e2a6d8b71?token=f4c0b2...",
  "accessToken": "f4c0b2..."
}
```

Use `pixelUrl` inside any HTML email. Keep the `accessToken` private; it acts as a bearer token for retrieving event logs.

## Minting Pixels from the CLI

The repo includes a helper script that wraps the API call:

```bash
export PIXIE_ENDPOINT="https://pixie.example.workers.dev"
export PIXIE_API_KEY="<your secret>"
npm run create:pixel -- --label "Quarterly update" --metadata campaign=q4 --metadata segment=vip
```

Flags override environment variables when provided (`--endpoint`, `--api-key`). Add `--json` to print the full JSON response or `--help` for usage details.

## Embedding in Gmail or Spark

1. Compose your email (Gmail web UI or Spark).
2. Switch to the HTML or rich-text view and insert the pixel URL as an image, e.g.:

   ```html
   <img src="https://pixie.example.workers.dev/pixel/4f9e2a6d8b71.gif" alt="" width="1" height="1" style="display:none" />
   ```

3. Send the email. When the recipient loads remote images, the Worker logs the event.

To review opens, visit the `eventsUrl` from the creation response. Append `&format=csv` to download a CSV snapshot.

## Privacy & Compliance Notes

- The Worker persists truncated IP addresses, user agents, accept-language headers, and Cloudflare-provided geo (country/region/city). Adjust `src/index.ts` if your data policy requires further minimisation or different retention windows.
- Document the tracking behaviour in your internal handbook (e.g. Workspace acceptable-use policy) and, when contacting external recipients, ensure your privacy notice or footer discloses remote-image tracking where required by law.
- Cloudflare Workers runs in multiple geographies; verify the chosen KV region satisfies your data residency requirements.
- Remote images can be disabled by recipients or filtered by security gateways. Expect false negatives and use the data as directional rather than definitive proof of receipt.

## Testing

Automated tests exercise the Worker directly with an in-memory KV stub and cover the create → open → report flow:

```bash
npm test
```

## Roadmap Ideas

- Use Durable Objects or R2 if you need stronger consistency or want to retain raw event logs beyond KV limits.
- Add a Google Apps Script that mints pixels on the fly from Gmail drafts, or build a Spark plugin that calls the Worker before send.
