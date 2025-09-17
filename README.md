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

## Embedding in Gmail or Spark

1. Compose your email (Gmail web UI or Spark).
2. Switch to the HTML or rich-text view and insert the pixel URL as an image, e.g.:

   ```html
   <img src="https://pixie.example.workers.dev/pixel/4f9e2a6d8b71.gif" alt="" width="1" height="1" style="display:none" />
   ```

3. Send the email. When the recipient loads remote images, the Worker logs the event.

To review opens, visit the `eventsUrl` from the creation response. Append `&format=csv` to download a CSV snapshot.

## Privacy & Compliance Notes

- The Worker stores a truncated IP address, user agent, requested language, and country/region/city when Cloudflare provides it. Adjust `src/index.ts` if you need to drop or further anonymize any fields.
- Update your workspace privacy policy and notify recipients where required. Remote images can be blocked by some clients; false negatives are expected.

## Next Steps

- Automate pixel creation via a small CLI or Apps Script that calls the Worker before sending an email.
- Use Durable Objects or a database if you expect a high volume of opens (KV's eventual consistency and 1 MB per value limit may become restrictive).
