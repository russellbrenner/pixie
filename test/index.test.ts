import { beforeEach, describe, expect, it } from "vitest";
import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import worker from "../src/index";

const API_KEY = "test-secret";

type TestEnv = {
  API_KEY: string;
  PIXIE_STORE: KVNamespace;
};

class MemoryKV {
  private store = new Map<string, string>();

  async get(key: string, options?: KVNamespaceGetOptions<"text" | "json">): Promise<any> {
    const value = this.store.get(key);
    if (value === undefined) {
      return null;
    }
    if (!options || options.type === "text") {
      return value;
    }
    if (options.type === "json") {
      return JSON.parse(value);
    }
    throw new Error("Unsupported get type");
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<unknown>> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys: { name: string }[] = [];
    for (const name of this.store.keys()) {
      if (!name.startsWith(prefix)) continue;
      keys.push({ name });
      if (keys.length >= limit) break;
    }
    return {
      keys,
      list_complete: keys.length < limit,
    } as KVNamespaceListResult<unknown>;
  }
}

function castRequest(
  request: Request,
  cf?: Partial<IncomingRequestCfProperties<unknown>>,
): Request<unknown, IncomingRequestCfProperties<unknown>> {
  if (cf) {
    Object.assign(request as any, { cf });
  }
  return request as unknown as Request<unknown, IncomingRequestCfProperties<unknown>>;
}

describe("Pixie worker", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = {
      API_KEY,
      PIXIE_STORE: new MemoryKV() as unknown as KVNamespace,
    };
  });

  it("creates a pixel and logs an open event", async () => {
    const createRequest = castRequest(new Request("https://example.com/api/pixels", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "integration-test",
        metadata: { campaign: "fall" },
      }),
    }));

    const createResponse = await worker.fetch(createRequest, env);
    expect(createResponse.status).toBe(201);
    const payload = (await createResponse.json()) as Record<string, string>;

    expect(payload.pixelUrl).toBeDefined();
    expect(payload.eventsUrl).toContain("token=");

    const pixelRequest = castRequest(new Request(payload.pixelUrl, {
      headers: {
        "user-agent": "vitest",
        "cf-connecting-ip": "203.0.113.42",
      },
    }), { country: "US", region: "CA", city: "San Francisco" });

    const pixelResponse = await worker.fetch(pixelRequest, env);
    expect(pixelResponse.status).toBe(200);
    expect(pixelResponse.headers.get("content-type")).toBe("image/gif");

    const reportRequest = castRequest(new Request(payload.eventsUrl));
    const reportResponse = await worker.fetch(reportRequest, env);
    expect(reportResponse.status).toBe(200);

    const report = (await reportResponse.json()) as {
      meta: { openCount: number; label: string; metadata: Record<string, unknown>; lastOpenedAt?: string | null };
      events: Array<{ anonymizedIp?: string | null; geo?: { country?: string } }>;
    };

    expect(report.meta.openCount).toBe(1);
    expect(report.meta.label).toBe("integration-test");
    expect(report.meta.metadata.campaign).toBe("fall");
    expect(report.events).toHaveLength(1);
    expect(report.events[0].anonymizedIp).toBe("203.0.113.0");
    expect(report.events[0].geo?.country).toBe("US");
  });

  it("rejects pixel creation without API key", async () => {
    const unauthorizedRequest = castRequest(new Request("https://example.com/api/pixels", {
      method: "POST",
    }));

    const response = await worker.fetch(unauthorizedRequest, env);
    expect(response.status).toBe(401);
  });
});
