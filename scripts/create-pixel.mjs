#!/usr/bin/env node
/* eslint-disable no-console */
const help = `Usage: node scripts/create-pixel.mjs [options]\n\nOptions:\n  --endpoint <url>    Worker base URL (defaults to $PIXIE_ENDPOINT)\n  --api-key <key>     API key (defaults to $PIXIE_API_KEY)\n  --label <text>      Optional label for the pixel\n  --metadata k=v      Attach metadata (repeatable)\n  --json              Output full JSON response\n  --help              Show this help message\n\nEnvironment Variables:\n  PIXIE_ENDPOINT      Default Worker base URL (e.g. https://pixie.example.workers.dev)\n  PIXIE_API_KEY       Default API key for authenticated requests\n`;

function parseArgs(argv) {
  const args = { metadata: {} };
  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    switch (token) {
      case "--help":
        args.help = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--label":
        args.label = tokens.shift();
        break;
      case "--endpoint":
        args.endpoint = tokens.shift();
        break;
      case "--api-key":
        args.apiKey = tokens.shift();
        break;
      case "--metadata": {
        const pair = tokens.shift();
        if (pair && pair.includes("=")) {
          const [k, ...rest] = pair.split("=");
          args.metadata[k] = rest.join("=");
        } else {
          throw new Error("--metadata expects key=value");
        }
        break;
      }
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

(async () => {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(help);
      process.exit(0);
    }

    const endpoint = parsed.endpoint ?? process.env.PIXIE_ENDPOINT;
    const apiKey = parsed.apiKey ?? process.env.PIXIE_API_KEY;
    if (!endpoint) {
      throw new Error("Missing Worker endpoint. Use --endpoint or set PIXIE_ENDPOINT.");
    }
    if (!apiKey) {
      throw new Error("Missing API key. Use --api-key or set PIXIE_API_KEY.");
    }

    const url = new URL("/api/pixels", endpoint.replace(/\/$/, ""));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: parsed.label,
        metadata: Object.keys(parsed.metadata).length ? parsed.metadata : undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed (${response.status}): ${text}`);
    }

    const payload = await response.json();

    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Pixel created (${payload.id})\nPixel URL:   ${payload.pixelUrl}\nEvents URL:  ${payload.eventsUrl}\nAccess token: ${payload.accessToken}`);
    }
  } catch (error) {
    console.error(error.message ?? error);
    console.error("\n", help);
    process.exit(1);
  }
})();
