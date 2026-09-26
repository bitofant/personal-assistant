import type { LlmChoice, LlmRouteRef, LlmTaskStatus } from "../shared/api.js";
import type { Config, LlmProvider, LlmTask } from "./config.js";

// OpenAI-compatible only (vLLM, llama.cpp, OpenAI, OpenRouter, …); no vendor branches past this file.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object (`response_format: json_object`); caller still validates. */
  json?: boolean;
  signal?: AbortSignal;
  /** User's pick among the task's configured routes; unknown/null = default. */
  route?: LlmRouteRef | null;
}

export interface ChatResult {
  text: string;
  /** Model id as reported by the server (may differ from the requested alias). */
  model: string;
  provider: string;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null };
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  provider: string;
}

export type LlmHealth = Omit<LlmTaskStatus, "task">;

/** `retryable` = outage/overload (keep job queued); false = our request or their reply is wrong. */
export class LlmError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status: number | null = null) {
    super(message);
    this.name = "LlmError";
  }
}

export interface Route {
  provider: LlmProvider;
  model: string;
}

/**
 * Resolve task → provider/model. Unrouted = feature off → retryable, so jobs wait for it to be configured.
 * `preferred` must be one of the task's configured routes (users can't point us at arbitrary models); else default.
 */
export function resolveRoute(config: Config, task: LlmTask, preferred?: LlmRouteRef | null): Route {
  const routes = config.llm.tasks[task];
  if (!routes?.length) throw new LlmError(`LLM task "${task}" not configured (llm.tasks.${task}).`, true);
  const r = (preferred && routes.find((q) => sameRoute(q, preferred))) || routes[0];
  const provider = config.llm.providers.find((p) => p.id === r.provider);
  // parseConfig rejects this; guard anyway since config reloads live.
  if (!provider) throw new LlmError(`LLM provider "${r.provider}" not configured.`, true);
  return { provider, model: r.model };
}

export function sameRoute(a: LlmRouteRef, b: LlmRouteRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** User-selectable routes for a task; first = default. */
export function routeChoices(config: Config, task: LlmTask): LlmChoice[] {
  return (config.llm.tasks[task] ?? []).map((r, i) => ({ provider: r.provider, model: r.model, isDefault: i === 0 }));
}

export function buildChatBody(model: string, messages: ChatMessage[], opts: ChatOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: "json_object" };
  return body;
}

export function parseChatResponse(raw: unknown, provider: string, requestedModel: string): ChatResult {
  const r = rec(raw);
  const choice = rec(Array.isArray(r.choices) ? r.choices[0] : undefined);
  const content = rec(choice.message).content;
  if (typeof content !== "string") throw new LlmError("LLM reply has no choices[0].message.content.", false);
  const usage = rec(r.usage);
  return {
    text: stripThinking(content),
    model: typeof r.model === "string" && r.model ? r.model : requestedModel,
    provider,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    // Missing ≠ zero.
    usage: { promptTokens: num(usage.prompt_tokens), completionTokens: num(usage.completion_tokens) },
  };
}

/** Reasoning models (qwen3, deepseek-r1) may inline `<think>…</think>` before the answer. */
export function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
}

/** Vectors in input order (servers may reorder by `index`). */
export function parseEmbeddingsResponse(raw: unknown, expected: number): number[][] {
  const data = rec(raw).data;
  if (!Array.isArray(data) || data.length !== expected)
    throw new LlmError(`Embeddings reply: expected ${expected} vectors, got ${Array.isArray(data) ? data.length : "none"}.`, false);
  const out: number[][] = new Array(expected);
  for (const [i, d] of data.entries()) {
    const item = rec(d);
    const idx = typeof item.index === "number" ? item.index : i;
    const v = item.embedding;
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "number"))
      throw new LlmError(`Embeddings reply: data[${i}].embedding is not a number array.`, false);
    if (!(idx >= 0 && idx < expected) || out[idx]) throw new LlmError(`Embeddings reply: bad index ${idx}.`, false);
    out[idx] = v as number[];
  }
  const dim = out[0].length;
  if (out.some((v) => v.length !== dim)) throw new LlmError("Embeddings reply: mixed dimensions.", false);
  return out;
}

export function parseModelsResponse(raw: unknown): string[] {
  const data = rec(raw).data;
  if (!Array.isArray(data)) throw new LlmError("Models reply has no data array.", false);
  return data.map((m) => rec(m).id).filter((id): id is string => typeof id === "string");
}

/** 408/409/429/5xx = transient; other 4xx = our bug or bad config (still retried a few times by the queue). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Error text from OpenAI (`{error:{message}}`), FastAPI (`{detail}`) or plain bodies. */
export function errorMessage(status: number, body: string): string {
  let msg = body.trim();
  try {
    const j = rec(JSON.parse(body));
    const e = j.error;
    msg = typeof e === "string" ? e : typeof rec(e).message === "string" ? (rec(e).message as string) : typeof j.detail === "string" ? j.detail : msg;
  } catch {
    // not JSON; keep text
  }
  return `HTTP ${status}${msg ? `: ${msg.slice(0, 500)}` : ""}`;
}

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- client (thin I/O) ----

export interface LlmOptions {
  /** Per call so config.json edits (routes, keys) apply without restart. */
  getConfig: () => Config;
  fetch?: typeof fetch;
  /** Long transcripts on a local model can take minutes. */
  chatTimeoutMs?: number;
  embedTimeoutMs?: number;
  healthTimeoutMs?: number;
  embedBatchSize?: number;
}

export interface Llm {
  chat(task: LlmTask, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed(task: LlmTask, inputs: string[], signal?: AbortSignal): Promise<EmbedResult>;
  health(task: LlmTask): Promise<LlmHealth>;
}

export function createLlm(opts: LlmOptions): Llm {
  const doFetch = opts.fetch ?? fetch;
  const chatTimeout = opts.chatTimeoutMs ?? 10 * 60_000;
  const embedTimeout = opts.embedTimeoutMs ?? 60_000;
  const healthTimeout = opts.healthTimeoutMs ?? 5_000;
  const batchSize = opts.embedBatchSize ?? 64;

  async function call(route: Route, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const { provider } = route;
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${provider.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      // Caller abort (shutdown) is not an outage, but the job must still survive → retryable.
      const why = timeout.aborted ? `timed out after ${timeoutMs} ms` : signal?.aborted ? "aborted" : causeText(err);
      throw new LlmError(`${provider.id} ${path}: ${why}`, true);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new LlmError(`${provider.id} ${path}: ${errorMessage(res.status, text)}`, isRetryableStatus(res.status), res.status);
    try {
      return JSON.parse(text);
    } catch {
      // HTML from a proxy/captive page mid-restart; treat as transient.
      throw new LlmError(`${provider.id} ${path}: reply is not JSON`, true, res.status);
    }
  }

  return {
    async chat(task, messages, o = {}) {
      const route = resolveRoute(opts.getConfig(), task, o.route);
      const raw = await call(route, "POST", "/chat/completions", buildChatBody(route.model, messages, o), chatTimeout, o.signal);
      return parseChatResponse(raw, route.provider.id, route.model);
    },

    async embed(task, inputs, signal) {
      const route = resolveRoute(opts.getConfig(), task);
      const vectors: number[][] = [];
      for (const batch of batches(inputs, batchSize)) {
        const raw = await call(route, "POST", "/embeddings", { model: route.model, input: batch }, embedTimeout, signal);
        vectors.push(...parseEmbeddingsResponse(raw, batch.length));
      }
      if (vectors.some((v) => v.length !== vectors[0].length)) throw new LlmError("Embeddings: mixed dimensions across batches.", false);
      return { vectors, model: route.model, provider: route.provider.id };
    },

    async health(task) {
      let route: Route;
      try {
        route = resolveRoute(opts.getConfig(), task);
      } catch (err) {
        return { ok: false, provider: null, model: null, modelListed: null, error: (err as Error).message };
      }
      const base = { provider: route.provider.id, model: route.model };
      try {
        const models = parseModelsResponse(await call(route, "GET", "/models", undefined, healthTimeout));
        // Listed-but-wrong-id is the common misconfig; flag it instead of failing every job later.
        const modelListed = models.includes(route.model);
        return { ...base, ok: modelListed, modelListed, error: modelListed ? null : `model "${route.model}" not in ${route.provider.id} /models` };
      } catch (err) {
        return { ...base, ok: false, modelListed: null, error: (err as Error).message };
      }
    },
  };
}

function causeText(err: unknown): string {
  // undici hides the real reason (ECONNREFUSED, ENOTFOUND) in `cause`.
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (err as Error)?.message ?? String(err);
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
