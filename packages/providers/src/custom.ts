import { createAnthropicProvider } from "./anthropic";
import { parseCustomModel } from "./catalog";
import { createOpenAIProvider } from "./openai";
import { createOpenRouterProvider } from "./openrouter";
import { type Endpoint, type ModelProvider, type ModelResult, ProviderError } from "./types";

/** The APIs a workspace's own endpoint may speak (a gateway, Ollama, vLLM, LM Studio, LiteLLM…). */
export type EndpointStyle = Endpoint["style"];
export const ENDPOINT_STYLES = ["openai", "openai-responses", "anthropic"] as const satisfies readonly EndpointStyle[];

const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 2_000_000;
const MAX_LISTED = 500;
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/**
 * The model ids an endpoint lists: `{ data: [{ id }] }` (OpenAI's and Anthropic's `GET /v1/models`, LiteLLM, vLLM,
 * LM Studio, Ollama's `/v1`), or Ollama's own `{ models: [{ model | name }] }`. Outside data: ids that don't look
 * like one are dropped, repeats too, at most 500.
 */
export function parseEndpointModels(body: unknown): { id: string; label?: string }[] {
  const root = obj(body);
  const rows = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const seen = new Set<string>();
  const out: { id: string; label?: string }[] = [];
  for (const row of rows) {
    const r = obj(row);
    const id = r && [r.id, r.model, r.name].find((v): v is string => typeof v === "string");
    if (!id || !MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = r.display_name;
    out.push({ id, ...(typeof name === "string" && name.trim() && name.length <= 120 ? { label: name.trim() } : {}) });
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** A response's body as JSON, read up to `max` bytes: a longer one fails. */
async function cappedJson(res: Response, max: number): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ProviderError("the model list is too large", false);
    }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

/**
 * An endpoint's model list, with the key: `GET {baseURL}/models` for Chat Completions, `GET {baseURL}/v1/models` for
 * Anthropic Messages. Ten seconds and 2 MB at most. A refusal or an unreadable answer throws a `ProviderError` whose
 * message the admin reads.
 */
export async function listEndpointModels(
  endpoint: Endpoint,
  apiKey: string,
  http: typeof fetch,
): Promise<{ id: string; label?: string }[]> {
  const url = endpoint.style === "anthropic" ? `${endpoint.baseURL}/v1/models` : `${endpoint.baseURL}/models`;
  const headers: Record<string, string> =
    endpoint.style === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" }
      : { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  let res: Response;
  try {
    res = await http(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (error) {
    throw new ProviderError(`could not reach provider: ${(error as Error).message}`, true);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError(`the provider answered ${res.status}`, false, res.status);
  }
  let body: unknown;
  try {
    body = await cappedJson(res, LIST_MAX_BYTES);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("could not read the model list", false);
  }
  return parseEndpointModels(body);
}

/** A reply's ceilings: a server people pointed us at (stuck, or hostile) can't fill this process's memory or hold a worker. */
export const ENDPOINT_REPLY_MAX_BYTES = 32_000_000;
export const ENDPOINT_CALL_TIMEOUT_MS = 20 * 60_000;

/** `http` with each exchange bounded: done within `timeoutMs` (the body streamed included), its body within `maxBytes`. */
export function boundedFetch(
  http: typeof fetch = fetch,
  limits = { maxBytes: ENDPOINT_REPLY_MAX_BYTES, timeoutMs: ENDPOINT_CALL_TIMEOUT_MS },
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const res = await http(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    if (!res.body) return res;
    let total = 0;
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > limits.maxBytes) controller.error(new ProviderError("the endpoint's reply is too large", false));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** `http` with `headers` set on every request, over what the SDK set itself (its own User-Agent). */
export const withHeaders = (http: typeof fetch, headers: Record<string, string>): typeof fetch =>
  ((input: string | URL | Request, init: RequestInit = {}) => {
    const merged = new Headers(init.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return http(input, { ...init, headers: merged });
  }) as typeof fetch;

/**
 * What OpenCode's gateway asks of a client that isn't OpenCode itself (opencode.ai/v2/docs/console/go, "Where can I
 * use it", read 2026-11-07): its own User-Agent, never an SDK's, and a stable session id per conversation in
 * `x-opencode-session`. Its Go plan refuses a call without them ("400 Request is missing x-opencode-session"). Null
 * for any other endpoint.
 */
export function endpointHeaders(baseURL: string, session: string, version = "dev"): Record<string, string> | null {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return null;
  }
  return host === "opencode.ai" || host.endsWith(".opencode.ai")
    ? { "user-agent": `agentes.chat/${version}`, "x-opencode-session": session }
    : null;
}

/**
 * Claude reads images wherever it is served (Amazon Bedrock's runtime and Mantle, a gateway): its ids all name it
 * (`global.anthropic.claude-sonnet-5-5`). Another company's model on an Anthropic-compatible endpoint isn't trusted to.
 */
const readsImages = (model: string) => /claude/i.test(model);

/**
 * The adapter for every workspace endpoint, registered once as `custom`: each call names its endpoint
 * (`StreamOptions.endpoint`) and goes through the catalog's own adapters with that address: Anthropic's in its
 * compatible mode, OpenAI's Responses one (`openai-responses`: the models that take tools with reasoning only there,
 * ADR 0177), or the Chat Completions one OpenRouter uses. The endpoint's model id is sent, the full
 * `custom:` id comes back (so a catalog id it may share is never priced at the catalog's prices), and a cost the
 * server reports is ignored: the admin's prices count. `version`: this server's, in the User-Agent an endpoint that
 * asks for one gets (`endpointHeaders`).
 */
export function createCustomProvider(
  options: { fetch?: typeof fetch; maxRetries?: number; version?: string } = {},
): ModelProvider {
  const bounded = boundedFetch(options.fetch);
  return {
    id: "custom",
    async stream(request, streamOptions): Promise<ModelResult> {
      const { endpoint } = streamOptions;
      const parsed = parseCustomModel(request.model);
      if (!endpoint || !parsed) throw new ProviderError("this model has no endpoint", false);
      const extra = endpointHeaders(endpoint.baseURL, streamOptions.session ?? crypto.randomUUID(), options.version);
      const http = extra ? withHeaders(bounded, extra) : bounded;
      const inner =
        endpoint.style === "anthropic"
          ? createAnthropicProvider({
              id: "custom",
              baseURL: endpoint.baseURL,
              compat: { toolChoiceAny: false, images: readsImages(parsed.model) },
              fetch: http,
              maxRetries: options.maxRetries,
            })
          : endpoint.style === "openai-responses"
            ? createOpenAIProvider({ baseURL: endpoint.baseURL, fetch: http, maxRetries: options.maxRetries })
            : createOpenRouterProvider({
                compatible: { id: "custom", baseURL: endpoint.baseURL },
                fetch: http,
                maxRetries: options.maxRetries,
              });
      const { costNanoUsd: _reported, ...result } = await inner.stream(
        { ...request, model: parsed.model },
        streamOptions,
      );
      return { ...result, model: request.model };
    },
  };
}
