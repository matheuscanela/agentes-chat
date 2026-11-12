/**
 * Provider-neutral model interface. Only the Model Gateway
 * (`@agenteschat/engine`, `createModelGateway`) calls it: no other code talks
 * to a model, and API keys never leave the backend.
 */

/** A piece of a message. Provider-specific blocks (thinking, fallback markers) travel as `opaque`. */
export type ContentBlock =
  /** `cache`: a prompt-cache breakpoint after this text (Anthropic; the history's end before per-turn notes). */
  (
    | { type: "text"; text: string; cache?: boolean }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    /** `images`: pictures and PDFs the tool returned (base64), shown to models that read them. */
    | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean; images?: ToolImage[] }
    /**
     * A block we don't interpret (e.g. Anthropic `thinking` with its signature).
     * It must be sent back to the same provider exactly as received when the
     * conversation continues (tool loops), so we keep the raw object.
     */
    | { type: "opaque"; provider: string; data: Record<string, unknown> }
  ) & {
    /**
     * On the first block of a reply written while the thinking sent back was left out (Anthropic dropped or
     * refused it), with or without thinking of its own: the provider with this id never sends the thinking before
     * this message again, or the API would drop or refuse the thinking written after it too.
     */
    restart?: string;
  };

/**
 * A picture (PNG, JPEG, GIF or WebP) or a PDF (`application/pdf`) in a tool's result, base64. A PDF goes to the
 * providers that read one as a document block; `pages` counts toward the prompt as its text would.
 */
export interface ToolImage {
  mediaType: string;
  data: string;
  /** A PDF: its pages, as counted when it was read. */
  pages?: number;
  /** A PDF: its file name (OpenAI asks for one). */
  name?: string;
}

export const PDF_MEDIA_TYPE = "application/pdf" as const;

/** What an image counts for in prompt estimates: about the tokens of a large one (≈1,600), never its base64 length. */
export const IMAGE_CHARS = 6400;
/** What a PDF page counts for: its text and its picture, which the providers both send (≈2,000 tokens). */
export const PDF_PAGE_CHARS = 8000;

/** What one picture or PDF of a tool result counts for in prompt estimates. */
export const toolImageChars = (i: ToolImage) =>
  i.mediaType === PDF_MEDIA_TYPE ? Math.max(1, i.pages ?? 1) * PDF_PAGE_CHARS : IMAGE_CHARS;

/** Whether a tool result carries a picture or a PDF. */
export const hasToolImages = (messages: ModelMessage[]) =>
  messages.some(
    (m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result" && b.images?.length),
  );

/**
 * The messages with tool results' pictures and PDFs left out, a note in their place: for endpoints that take text
 * only (another company's Anthropic-compatible API, OpenRouter), where one would fail the whole request. The note
 * names the AI (`model`) and the way out, so the agent tells the person the real cause.
 */
export const withoutImages = (messages: ModelMessage[], model?: string): ModelMessage[] =>
  messages.map((m) =>
    typeof m.content === "string"
      ? m
      : {
          ...m,
          content: m.content.map((b) => {
            if (b.type !== "tool_result" || !b.images?.length) return b;
            const { images, ...rest } = b;
            const pdf = images.some((i) => i.mediaType === PDF_MEDIA_TYPE);
            const picture = images.some((i) => i.mediaType !== PDF_MEDIA_TYPE);
            const what = pdf && picture ? "picture and the PDF" : pdf ? "PDF" : "picture";
            const ai = model ? `this agent's AI (${model})` : "this agent's AI";
            return {
              ...rest,
              content: `${b.content}\n[The ${what} is not shown to you: ${ai} reads text only through this connection. Tell the person exactly that, and that an AI that reads ${pdf ? "pictures and PDFs" : "pictures"} (Claude, GPT or Gemini), picked in this agent's settings, would see it. Never say the file came empty.]`,
            };
          }),
        },
  );

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** A block of the system prompt. `cache` marks a prompt-cache breakpoint after this block. */
export interface SystemBlock {
  text: string;
  cache?: boolean;
  /** Read after the conversation (`ModelRequest.notes` carries it there), not in the system. */
  after?: boolean;
}

export type SystemPrompt = string | SystemBlock[];

/** A tool the model may call. Execution never happens in the provider: callers run tools (Tool Gateway). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) of the tool input. */
  inputSchema: Record<string, unknown>;
  /**
   * The same in every run of the agent, whatever else loads: the stable tools are sent first and the others after
   * (each part sorted by name), with a prompt-cache breakpoint after the last stable one where the provider takes it,
   * so loading a tool group doesn't throw away the cached tools before it.
   */
  stable?: boolean;
}

export interface ModelRequest {
  model: string;
  system: SystemPrompt;
  /** Must start with a `user` turn; roles alternate. */
  messages: ModelMessage[];
  maxTokens: number;
  tools?: ToolSpec[];
  /** JSON Schema the reply must follow (structured output). The reply text is then JSON. */
  outputSchema?: Record<string, unknown>;
  /**
   * How much reasoning to spend. Providers without the notion ignore it. Default: the provider's.
   * `none`: the least the model allows (its catalog `leastThinking`), else `low`.
   */
  effort?: "none" | "low" | "medium" | "high";
  /**
   * `1h`: the breakpoints of the stable prefix (stable tools, system blocks marked `cache`) last an hour where the
   * provider offers it (Anthropic's extended TTL, written at 2× the input price); the conversation's tail keeps the
   * 5-minute default. Absent: 5 minutes everywhere.
   */
  cacheTtl?: "1h";
  /**
   * What changes from run to run, read after the history (token-trim B8): `text` follows the text of message `at` (the
   * trigger's), whose own text then carries a cache point when history comes before it; the system blocks marked
   * `after` are left out of the system. Absent: the system as it is.
   */
  notes?: { at: number; text: string };
  signal?: AbortSignal;
}

/** The request as an adapter sends it: `notes` after the trigger's text, the `after` blocks out of the system. */
export function laidOut(request: ModelRequest): ModelRequest {
  const { notes } = request;
  const trigger = notes ? request.messages[notes.at] : undefined;
  if (!notes || trigger?.role !== "user" || typeof request.system === "string") return request;
  const own: ContentBlock[] =
    typeof trigger.content === "string" ? [{ type: "text", text: trigger.content }] : [...trigger.content];
  const last = own.at(-1);
  if (notes.at > 0 && last?.type === "text") own[own.length - 1] = { ...last, cache: true };
  return {
    ...request,
    system: request.system.filter((b) => !b.after),
    messages: request.messages.map((m, i) =>
      i === notes.at ? { role: m.role, content: [...own, { type: "text", text: notes.text }] } : m,
    ),
  };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Of `cacheWriteTokens`, those written to the 1-hour cache (`cacheTtl`), priced higher; absent: none. */
  cacheWriteLongTokens?: number;
}

export type StopReason = "end_turn" | "max_tokens" | "refusal" | "tool_use" | "other";

export interface ModelResult {
  /** Concatenated text blocks. */
  text: string;
  /** Every block of the reply, in order (text, tool calls, opaque provider blocks). */
  content: ContentBlock[];
  /** Model that actually answered: may differ from the request after a server-side fallback. */
  model: string;
  stopReason: StopReason;
  usage: ModelUsage;
  /** What the provider says the call cost (OpenRouter's `usage.cost`); absent: priced from the catalog. */
  costNanoUsd?: number;
  /**
   * Thinking sent back that the call went without (Anthropic): the blocks the API dropped, by reason, or the
   * refusal that sent the call again without any.
   */
  thinking?: { dropped?: Record<string, number>; refused?: string };
  /** Tool results' pictures or PDFs were left out: this connection takes text only (`withoutImages`). */
  imagesLeftOut?: true;
}

export interface StreamOptions {
  apiKey: string;
  /** Account scoping some providers need (Anthropic: `anthropic-workspace-id`). */
  workspaceId?: string;
  /** OpenAI organization and project (headers), when the key needs them. */
  organization?: string;
  project?: string;
  /** A workspace's own endpoint the call goes to (`custom` provider, ADR 0146). */
  endpoint?: Endpoint;
  /**
   * The conversation the call belongs to, the same on each of its calls and never a secret: an endpoint that routes
   * and caches by it gets it (OpenCode's `x-opencode-session`). Absent: each call is its own.
   */
  session?: string;
  /** Called with each text fragment as it is generated. */
  onDelta(text: string): void;
}

/**
 * A workspace's own model endpoint (ADR 0146). `baseURL` is what that API's SDK takes: `https://host/v1` for Chat
 * Completions (`openai`) or the Responses API (`openai-responses`), `https://host/anthropic` (no `/v1`) for Anthropic
 * Messages.
 */
export interface Endpoint {
  style: "openai" | "openai-responses" | "anthropic";
  baseURL: string;
}

export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, options: StreamOptions): Promise<ModelResult>;
  /** Exact input-token count of a request (provider API). Optional: callers fall back to an estimate. */
  countTokens?(
    request: ModelRequest,
    options: { apiKey: string; workspaceId?: string; organization?: string; project?: string },
  ): Promise<number>;
}

/** What the provider had already reported or sent when a stream failed. */
export interface PartialUsage {
  /** From the provider's start-of-stream event; null when the stream died before it. */
  inputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Of `cacheWriteTokens`, those written to the 1-hour cache. */
  cacheWriteLongTokens?: number;
  /** Output tokens reported by the provider so far, or null when it reported none. */
  outputTokens: number | null;
  /** Characters of output received (text and tool input), for a local estimate. */
  outputChars: number;
}

/** A provider failure. `retryable` drives the outbox retry (rate limits, overload, network). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    /** Set when the failure happened mid-stream, so the gateway can bill what was consumed. */
    public partial?: PartialUsage,
    /** The provider's own words, when it gave any. */
    public said?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
  /** Who answered, as people read the name. The gateway sets it: an adapter serves several. */
  provider?: string;
  /** It came on the server's own key: the person has nothing to fix. */
  platformKey?: boolean;
}

/** What a provider's failure comes down to, for the words and the way out people get. */
export type ProviderCause =
  | "no_credit"
  | "invalid_key"
  | "no_access"
  | "model_unavailable"
  | "rate_limit"
  | "down"
  | "timeout"
  | "unreachable";

const NO_CREDIT =
  /no prepaid credit|insufficient[ _](?:credits?|quota|balance|funds)|credit balance|requires more credits|exceeded your current quota|key limit exceeded|quota used up|api usage limits|billing (?:hard )?limit/i;
const BAD_KEY = /invalid (?:x-)?(?:provider )?api[ _-]?key|incorrect api key|api key not valid/i;
const NO_MODEL =
  /not a valid model|model[_ ]not[_ ]found|no endpoints found|no allowed providers|model .{0,80}does not exist/i;

/**
 * The cause in a failure's status and words, or null when they name none. The words come first for credit: OpenAI
 * says it on a 429, Claude on a 400 and OpenRouter on a 403 (a key's own limit).
 */
export function providerCause(error: Pick<ProviderError, "status" | "message" | "said">): ProviderCause | null {
  const { status = 0 } = error;
  const words = `${error.said ?? ""} ${error.message}`;
  if (status === 402 || NO_CREDIT.test(words)) return "no_credit";
  if (status === 401 || BAD_KEY.test(words)) return "invalid_key";
  if (status === 404 || NO_MODEL.test(words)) return "model_unavailable";
  // OpenRouter's 403 is also its moderation refusing the text: no key fixes that, its words say why.
  if (status === 403) return /moderation|flagged/i.test(words) ? null : "no_access";
  if (status === 429 || /rate.?limit|too many requests/i.test(words)) return "rate_limit";
  if (status === 408 || status === 504 || status === 524 || /timed? ?out/i.test(words)) return "timeout";
  if (status >= 500 || /overloaded/i.test(words)) return "down";
  return /could not reach/.test(words) ? "unreachable" : null;
}

/** A provider's words on one line, short enough to show. */
export const shortSaid = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * A 403, with the provider's words when it gave any: a key with no rights and a project that doesn't offer one model
 * are both 403s, and only the words tell them apart (`keyRefusalOf`).
 */
export const deniedError = (code?: string | null, said = "") =>
  new ProviderError(
    `provider denied access${said ? ` (${["403", code].filter(Boolean).join(" ")}): ${said}` : ""}`,
    false,
    403,
    undefined,
    said || undefined,
  );

/** Rough token estimate (≈ 4 characters per token), used only when the provider gave no count. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** Characters of a request's prompt (system, messages, tools), for estimates. */
export function promptChars(request: Pick<ModelRequest, "system" | "messages" | "tools">): number {
  const system =
    typeof request.system === "string" ? request.system.length : request.system.reduce((n, b) => n + b.text.length, 0);
  let messages = 0;
  for (const m of request.messages)
    messages += typeof m.content === "string" ? m.content.length : blocksChars(m.content);
  const tools = request.tools ? JSON.stringify(request.tools).length : 0;
  return system + messages + tools;
}

/** Characters of a message's blocks, an image as `IMAGE_CHARS` and a PDF by its pages (`toolImageChars`). */
export function blocksChars(content: ContentBlock[]): number {
  let images = 0;
  const json = JSON.stringify(content, (key, value) => {
    if (key !== "images" || !Array.isArray(value)) return value;
    for (const i of value as ToolImage[]) images += toolImageChars(i);
    return undefined;
  });
  return json.length + images;
}

/** Tools in the order providers send them: the stable ones, then the others, each part sorted by name. */
export const stableToolsFirst = <T extends Pick<ToolSpec, "name" | "stable">>(tools: readonly T[]): T[] => {
  const byName = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return [...byName.filter((t) => t.stable), ...byName.filter((t) => !t.stable)];
};

/** Concatenated text of a message content. */
export const textOf = (content: string | ContentBlock[]) =>
  typeof content === "string"
    ? content
    : content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");

/** Flattens a system prompt into one string (for providers without blocks, and tests). */
export const systemText = (system: SystemPrompt) =>
  typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
