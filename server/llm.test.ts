import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "./config.js";
import {
  batches,
  buildChatBody,
  createLlm,
  errorMessage,
  isRetryableStatus,
  LlmError,
  parseChatResponse,
  parseEmbeddingsResponse,
  parseModelsResponse,
  resolveRoute,
  routeChoices,
  stripThinking,
} from "./llm.js";

const config: Config = parseConfig({
  llm: {
    providers: [
      { id: "local", baseUrl: "http://llm:8000/v1/", models: ["m"] },
      { id: "paid", baseUrl: "https://paid/v1", apiKey: "sk-1", models: ["e"] },
    ],
    tasks: { summary: { provider: "local", model: "m" }, embed: { provider: "paid", model: "e" } },
  },
});

const chatReply = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: "m-full",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 18, completion_tokens: 2 },
  ...extra,
});

describe("resolveRoute", () => {
  it("routes a task to its provider + model", () => {
    const r = resolveRoute(config, "summary");
    expect(r.provider.baseUrl).toBe("http://llm:8000/v1");
    expect(r.model).toBe("m");
  });

  it("preferred route only if configured for the task, else default", () => {
    const c = parseConfig({
      llm: {
        providers: [{ id: "local", baseUrl: "http://llm/v1" }, { id: "paid", baseUrl: "https://paid/v1" }],
        tasks: { summary: [{ provider: "local", model: "m" }, { provider: "paid", model: "big" }] },
      },
    });
    expect(resolveRoute(c, "summary", { provider: "paid", model: "big" })).toMatchObject({ provider: { id: "paid" }, model: "big" });
    expect(resolveRoute(c, "summary", { provider: "paid", model: "m" })).toMatchObject({ provider: { id: "local" }, model: "m" });
    expect(resolveRoute(c, "summary", null).model).toBe("m");
    expect(routeChoices(c, "summary")).toEqual([
      { provider: "local", model: "m", isDefault: true },
      { provider: "paid", model: "big", isDefault: false },
    ]);
    expect(routeChoices(c, "search")).toEqual([]);
  });

  it("unrouted task = retryable (feature off, jobs wait)", () => {
    const e = catchErr(() => resolveRoute(config, "search"));
    expect(e).toBeInstanceOf(LlmError);
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/llm.tasks.search/);
  });
});

describe("buildChatBody", () => {
  it("only sends options that were set", () => {
    expect(buildChatBody("m", [{ role: "user", content: "hi" }])).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(buildChatBody("m", [], { temperature: 0, maxTokens: 5, json: true })).toMatchObject({
      temperature: 0,
      max_tokens: 5,
      response_format: { type: "json_object" },
    });
  });
});

describe("parseChatResponse", () => {
  it("parses a vLLM reply (shape verified live)", () => {
    expect(parseChatResponse(chatReply("pong"), "local", "m")).toEqual({
      text: "pong",
      model: "m-full",
      provider: "local",
      finishReason: "stop",
      usage: { promptTokens: 18, completionTokens: 2 },
    });
  });

  it("missing usage/model → null / requested model, not 0", () => {
    const r = parseChatResponse({ choices: [{ message: { content: "x" } }] }, "local", "m");
    expect(r.usage).toEqual({ promptTokens: null, completionTokens: null });
    expect(r.model).toBe("m");
    expect(r.finishReason).toBeNull();
  });

  it("no content = non-retryable", () => {
    for (const bad of [{}, { choices: [] }, chatReply(null)]) {
      const e = catchErr(() => parseChatResponse(bad, "local", "m"));
      expect(e.retryable).toBe(false);
    }
  });
});

describe("stripThinking", () => {
  it("drops a leading think block only", () => {
    expect(stripThinking("<think>\nhmm\n</think>\n\nanswer")).toBe("answer");
    expect(stripThinking("answer <think>x</think>")).toBe("answer <think>x</think>");
  });
});

describe("parseEmbeddingsResponse", () => {
  it("orders vectors by index", () => {
    const raw = { data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] };
    expect(parseEmbeddingsResponse(raw, 2)).toEqual([[1, 1], [2, 2]]);
  });

  it("rejects wrong count, duplicate index, mixed dims, non-numbers", () => {
    const cases = [
      [{ data: [{ index: 0, embedding: [1] }] }, 2],
      [{ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }, 2],
      [{ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }] }, 2],
      [{ data: [{ index: 0, embedding: ["x"] }] }, 1],
      [{}, 1],
    ] as const;
    for (const [raw, n] of cases) expect(() => parseEmbeddingsResponse(raw, n)).toThrow(LlmError);
  });
});

describe("parseModelsResponse", () => {
  it("lists ids", () => {
    expect(parseModelsResponse({ object: "list", data: [{ id: "a" }, { id: "b" }, {}] })).toEqual(["a", "b"]);
    expect(() => parseModelsResponse({})).toThrow(LlmError);
  });
});

describe("errors", () => {
  it("classifies statuses", () => {
    expect([408, 409, 429, 500, 502, 503].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isRetryableStatus)).toBe(false);
  });

  it("extracts OpenAI, FastAPI and plain error bodies (shapes verified live)", () => {
    expect(errorMessage(404, '{"error":{"message":"The model `nope` does not exist.","code":404}}')).toBe(
      "HTTP 404: The model `nope` does not exist.",
    );
    expect(errorMessage(404, '{"detail":"Not Found"}')).toBe("HTTP 404: Not Found");
    expect(errorMessage(502, "Bad Gateway")).toBe("HTTP 502: Bad Gateway");
    expect(errorMessage(500, "")).toBe("HTTP 500");
  });

  it("batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });
});

// ---- client with a fake fetch (no network) ----

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("createLlm", () => {
  it("chat: posts to the routed provider, no auth header without a key", async () => {
    const { f, calls } = fakeFetch(() => json(chatReply("hi")));
    const llm = createLlm({ getConfig: () => config, fetch: f });
    const r = await llm.chat("summary", [{ role: "user", content: "x" }], { temperature: 0 });
    expect(r.text).toBe("hi");
    expect(calls[0].url).toBe("http://llm:8000/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ model: "m", temperature: 0 });
  });

  it("embed: bearer key, batching, input order kept", async () => {
    const { f, calls } = fakeFetch(({ init }) => {
      const input = JSON.parse(init.body as string).input as string[];
      return json({ data: input.map((s, index) => ({ index, embedding: [s.length, 1] })).reverse() });
    });
    const llm = createLlm({ getConfig: () => config, fetch: f, embedBatchSize: 2 });
    const r = await llm.embed("embed", ["a", "bb", "ccc"]);
    expect(r.vectors).toEqual([[1, 1], [2, 1], [3, 1]]);
    expect(calls).toHaveLength(2);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-1");
  });

  it("connection refused / 503 = retryable; 400 = not", async () => {
    const refused = createLlm({
      getConfig: () => config,
      fetch: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch,
    });
    const e1 = await refused.chat("summary", []).catch((e) => e);
    expect(e1).toMatchObject({ retryable: true, status: null });
    expect(e1.message).toMatch(/ECONNREFUSED/);

    const e2 = await createLlm({ getConfig: () => config, fetch: fakeFetch(() => json({ error: "busy" }, 503)).f })
      .chat("summary", [])
      .catch((e) => e);
    expect(e2).toMatchObject({ retryable: true, status: 503 });

    const e3 = await createLlm({ getConfig: () => config, fetch: fakeFetch(() => json({ error: { message: "bad" } }, 400)).f })
      .chat("summary", [])
      .catch((e) => e);
    expect(e3).toMatchObject({ retryable: false, status: 400 });
    expect(e3.message).toMatch(/HTTP 400: bad/);
  });

  it("non-JSON 200 (proxy page) = retryable", async () => {
    const llm = createLlm({ getConfig: () => config, fetch: fakeFetch(() => new Response("<html>")).f });
    expect(await llm.chat("summary", []).catch((e) => e)).toMatchObject({ retryable: true });
  });

  it("timeout = retryable", async () => {
    const hang = (async (_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const llm = createLlm({ getConfig: () => config, fetch: hang, chatTimeoutMs: 10 });
    const e = await llm.chat("summary", []).catch((e) => e);
    expect(e).toMatchObject({ retryable: true });
    expect(e.message).toMatch(/timed out/);
  });

  it("reads config per call (live reload)", async () => {
    let c = config;
    const { f, calls } = fakeFetch(() => json(chatReply("x")));
    const llm = createLlm({ getConfig: () => c, fetch: f });
    await llm.chat("summary", []);
    c = parseConfig({ llm: { providers: [{ id: "b", baseUrl: "http://b/v1" }], tasks: { summary: { provider: "b", model: "z" } } } });
    await llm.chat("summary", []);
    expect(calls.map((x) => x.url)).toEqual(["http://llm:8000/v1/chat/completions", "http://b/v1/chat/completions"]);
  });

  it("health: ok / model not listed / unreachable / unrouted", async () => {
    const listed = createLlm({ getConfig: () => config, fetch: fakeFetch(() => json({ data: [{ id: "m" }] })).f });
    expect(await listed.health("summary")).toEqual({ ok: true, provider: "local", model: "m", modelListed: true, error: null });

    const other = createLlm({ getConfig: () => config, fetch: fakeFetch(() => json({ data: [{ id: "x" }] })).f });
    expect(await other.health("summary")).toMatchObject({ ok: false, modelListed: false, error: expect.stringMatching(/not in local/) });

    const down = createLlm({ getConfig: () => config, fetch: fakeFetch(() => json({}, 502)).f });
    expect(await down.health("summary")).toMatchObject({ ok: false, provider: "local", modelListed: null });

    expect(await listed.health("search")).toMatchObject({ ok: false, provider: null, model: null, modelListed: null });
  });
});

function catchErr(fn: () => unknown): LlmError {
  try {
    fn();
  } catch (e) {
    return e as LlmError;
  }
  throw new Error("expected a throw");
}
