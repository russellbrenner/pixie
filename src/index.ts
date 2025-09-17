import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";

interface Env {
  PIXIE_STORE: KVNamespace;
  API_KEY: string;
}

type PixelInitPayload = {
  label?: string;
  metadata?: Record<string, string | number | boolean>;
};

type PixelMeta = {
  id: string;
  createdAt: string;
  label?: string | null;
  metadata?: Record<string, string | number | boolean>;
  tokenHash: string;
  openCount: number;
  lastOpenedAt?: string;
};

type PixelEvent = {
  timestamp: string;
  anonymizedIp?: string | null;
  userAgent?: string | null;
  referer?: string | null;
  language?: string | null;
  geo?: {
    country?: string;
    city?: string;
    region?: string;
  } | null;
};

const API_KEY_HEADER = "x-api-key";

const TRANSPARENT_GIF = Uint8Array.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33,
  249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (request.method === "POST" && pathname === "/api/pixels") {
      const authError = validateApiKey(request, env);
      if (authError) return authError;
      return createPixel(request, env, url);
    }

    if (request.method === "GET" && pathname.startsWith("/api/pixels/")) {
      return getPixelReport(request, env, url);
    }

    if ((request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/pixel/")) {
      return servePixel(request, env, url, request.method === "HEAD");
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function createPixel(request: Request, env: Env, url: URL): Promise<Response> {
  const payload = (await safeJson<PixelInitPayload>(request)) ?? {};

  const id = randomHex(9);
  const accessToken = randomHex(16);
  const tokenHash = await sha256Hex(accessToken);

  const createdAt = new Date().toISOString();
  const meta: PixelMeta = {
    id,
    createdAt,
    label: payload.label ?? null,
    metadata: payload.metadata,
    tokenHash,
    openCount: 0,
  };

  await env.PIXIE_STORE.put(metaKey(id), JSON.stringify(meta));

  const responseBody = {
    id,
    createdAt,
    pixelUrl: new URL(`/pixel/${id}.gif`, url.origin).toString(),
    eventsUrl: new URL(`/api/pixels/${id}?token=${accessToken}`, url.origin).toString(),
    accessToken,
  };

  return jsonResponse(responseBody, 201, request);
}

async function getPixelReport(request: Request, env: Env, url: URL): Promise<Response> {
  const id = url.pathname.split("/").filter(Boolean)[2];
  if (!id) {
    return new Response("Missing pixel id", { status: 400 });
  }

  const meta = await loadMeta(env, id);
  if (!meta) {
    return new Response("Pixel not found", { status: 404 });
  }

  const providedToken = new URL(request.url).searchParams.get("token");
  if (!providedToken || (await sha256Hex(providedToken)) !== meta.tokenHash) {
    return new Response("Unauthorized", { status: 401 });
  }

  const format = new URL(request.url).searchParams.get("format");
  const events = await loadEvents(env, id);

  if (format === "csv") {
    const csv = buildCsv(meta, events);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": `attachment; filename=\"${id}-events.csv\"`,
        ...corsHeaders(request),
      },
    });
  }

  return jsonResponse({ meta: sanitizeMeta(meta), events }, 200, request);
}

async function servePixel(request: Request, env: Env, url: URL, isHead: boolean): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  const rawId = segments[1] ?? "";
  const id = rawId.replace(/\.gif$/i, "");

  const meta = await loadMeta(env, id);

  if (meta) {
    const event = await buildEventRecord(request);
    await storeEvent(env, id, event);
    meta.openCount += 1;
    meta.lastOpenedAt = event.timestamp;
    await env.PIXIE_STORE.put(metaKey(id), JSON.stringify(meta));
  }

  const headers = {
    "cache-control": "no-store, must-revalidate",
    "content-type": "image/gif",
    "content-length": TRANSPARENT_GIF.byteLength.toString(),
    "access-control-allow-origin": "*",
  } satisfies HeadersInit;

  if (isHead) {
    return new Response(null, { headers });
  }

  return new Response(TRANSPARENT_GIF, { headers });
}

async function buildEventRecord(request: Request): Promise<PixelEvent> {
  const now = new Date().toISOString();
  const ip = request.headers.get("cf-connecting-ip");
  const referer = request.headers.get("referer");
  const language = request.headers.get("accept-language");
  const userAgent = request.headers.get("user-agent");
  const geo = "cf" in request ? sanitizeGeo((request as Request & { cf?: IncomingRequestCfProperties }).cf) : null;

  return {
    timestamp: now,
    anonymizedIp: anonymizeIp(ip),
    userAgent: truncate(userAgent, 256),
    referer: truncate(referer, 256),
    language: truncate(language, 32),
    geo,
  };
}

async function storeEvent(env: Env, id: string, event: PixelEvent): Promise<void> {
  const key = `${eventKeyPrefix(id)}${Date.now()}-${randomHex(3)}`;
  await env.PIXIE_STORE.put(key, JSON.stringify(event));
}

async function loadEvents(env: Env, id: string): Promise<PixelEvent[]> {
  const prefix = eventKeyPrefix(id);
  const list = await env.PIXIE_STORE.list({ prefix, limit: 1000 });
  const events = await Promise.all(
    list.keys.map((entry) => env.PIXIE_STORE.get(entry.name, { type: "json" }) as Promise<PixelEvent | null>),
  );
  return events
    .filter((value): value is PixelEvent => Boolean(value))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

async function loadMeta(env: Env, id: string): Promise<PixelMeta | null> {
  const stored = await env.PIXIE_STORE.get(metaKey(id), { type: "json" });
  if (!stored) {
    return null;
  }
  return stored as PixelMeta;
}

function sanitizeMeta(meta: PixelMeta) {
  const { tokenHash, ...safe } = meta;
  return safe;
}

function eventKeyPrefix(id: string) {
  return `events:${id}:`;
}

function metaKey(id: string) {
  return `meta:${id}`;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function anonymizeIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(".")) {
    const segments = ip.split(".");
    if (segments.length === 4) {
      segments[3] = "0";
      return segments.join(".");
    }
  }
  if (ip.includes(":")) {
    const segments = ip.split(":");
    for (let i = Math.max(0, segments.length - 4); i < segments.length; i += 1) {
      segments[i] = "0000";
    }
    return segments.join(":");
  }
  return null;
}

function sanitizeGeo(cf: IncomingRequestCfProperties | undefined): PixelEvent["geo"] {
  if (!cf) return null;
  const { country, city, region } = cf;
  if (!country && !city && !region) return null;
  return {
    country: country ?? undefined,
    city: city ?? undefined,
    region: region ?? undefined,
  };
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function corsHeaders(request: Request | null): HeadersInit {
  const origin = request?.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
    "access-control-allow-headers": `${API_KEY_HEADER}, content-type`,
  };
}

function jsonResponse(data: unknown, status = 200, request?: Request): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      ...corsHeaders(request ?? null),
    },
  });
}

async function safeJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch (error) {
    return null;
  }
}

function validateApiKey(request: Request, env: Env): Response | null {
  if (!env.API_KEY) {
    return new Response("Server misconfigured: missing API_KEY", { status: 500 });
  }
  const providedKey = request.headers.get(API_KEY_HEADER);
  if (!providedKey || providedKey !== env.API_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

function buildCsv(meta: PixelMeta, events: PixelEvent[]): string {
  const headers = ["timestamp", "anonymizedIp", "userAgent", "referer", "language", "country", "region", "city"];
  const lines = [headers.join(",")];

  for (const event of events) {
    const row = [
      event.timestamp ?? "",
      event.anonymizedIp ?? "",
      escapeCsv(event.userAgent),
      escapeCsv(event.referer),
      escapeCsv(event.language),
      event.geo?.country ?? "",
      event.geo?.region ?? "",
      event.geo?.city ?? "",
    ];
    lines.push(row.join(","));
  }

  return lines.join("\n");
}

function escapeCsv(value: string | null | undefined): string {
  if (!value) return "";
  const escaped = value.replace(/"/g, '""');
  if (escaped.includes(",") || escaped.includes("\n")) {
    return `"${escaped}"`;
  }
  return escaped;
}
