import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { MODEL_CATALOG } from "./catalog";
import {
  type ContentBlock,
  deniedError,
  hasToolImages,
  laidOut,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type PartialUsage,
  PDF_MEDIA_TYPE,
  ProviderError,
  type StopReason,
  shortSaid,
  stableToolsFirst,
  type ToolSpec,
  withoutImages,
} from "./types";

/** The tool a compatible endpoint gives structured output through: its input is the reply. */
const STRUCTURED_OUTPUT = "structured_output";

/** Lets a request say what happens to thinking the API can no longer read back (`block_binding`). */
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/**
 * Anthropic Messages API, streaming. A client is created per call with the
 * org's decrypted key (never cached or logged).
 *
 * - Prompt caching: the stable tools go first (`ToolSpec.stable`) with a
 *   breakpoint after the last one, so loading a tool group keeps them cached;
 *   every system block marked `cache` gets a breakpoint (the latest ones when
 *   the 4 allowed would be passed), and top-level automatic caching covers
 *   the growing conversation in tool loops. Each part of the tools is sorted
 *   by name so its prefix is deterministic. `cacheTtl: "1h"` makes the tool and
 *   system breakpoints last an hour; the automatic one stays at 5 minutes
 *   (longer entries must come first).
 * - Tool use: client tools with `eager_input_streaming`; inputs are validated
 *   by the Tool Gateway before anything runs. Thinking and other provider
 *   blocks come back as `opaque` and are replayed unchanged, only to the
 *   provider that wrote them.
 * - Preserved thinking: Claude reads a thinking block back only while the
 *   system prompt, the tools and every message before it are the ones it was
 *   written with, and refuses the call otherwise (accounts created since
 *   2026-08-31). A run's tools change between calls (a computer that stops
 *   answering, a permission turned on), so the API is asked to drop such a
 *   block instead. It drops every later thinking block with it, so the reply
 *   to that call is a `restart`: the thinking before it is never sent again.
 *   A call refused for its thinking all the same goes once more without any,
 *   and its reply is a `restart` too. Both show on `ModelResult.thinking`.
 * - Structured output: `outputSchema` maps to `output_config.format`.
 * - Models flagged `serverSideFallback` opt into Anthropic's server-side
 *   refusal fallback; the answering model is reported back for pricing.
 * - Mid-stream failures carry the usage seen so far (`ProviderError.partial`);
 *   a refused request keeps the API's error type and words.
 *
 * `compat` points it at another company's Anthropic-compatible endpoint
 * (`baseURL`, `id`). It keeps the beta client and the system blocks' cache
 * breakpoints, and leaves out what they don't all take: top-level caching
 * (each caches prompt prefixes by itself), fallbacks, eager input
 * streaming, `countTokens` and `output_config.format`. Structured output is a
 * `structured_output` tool, forced where `tool_choice: any` is honored, and
 * its input comes back as the reply's JSON text. Medium effort is sent as
 * `high`: Kimi and GLM take only low, high and max. Tool results' images are left out too, unless `compat.images`
 * says the model reads them (Claude served by Amazon Bedrock).
 */
export function createAnthropicProvider(
  options: {
    /** The provider's id in `PROVIDERS`. */
    id?: string;
    baseURL?: string;
    compat?: { toolChoiceAny: boolean; images?: boolean };
    maxRetries?: number;
    /** Tests only: scripted transport. */
    fetch?: typeof fetch;
  } = {},
): ModelProvider {
  const id = options.id ?? "anthropic";
  const { compat } = options;
  const client = (apiKey: string, workspaceId?: string) =>
    new Anthropic({
      apiKey,
      baseURL: options.baseURL,
      maxRetries: options.maxRetries ?? 2,
      fetch: options.fetch,
      // Keys not scoped to a workspace must name one on every request.
      ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
    });

  return {
    id,
    async stream(input, { apiKey, workspaceId, onDelta }): Promise<ModelResult> {
      const request = laidOut(input);
      const info = MODEL_CATALOG[request.model];
      const fallback = !compat && info?.serverSideFallback === true;
      const format = compat ? undefined : request.outputSchema;
      const answerSchema = compat ? request.outputSchema : undefined;
      const tools = [
        ...toTools(request.tools ?? [], !compat, compat ? undefined : cacheControl(request)),
        ...(answerSchema
          ? [
              {
                name: STRUCTURED_OUTPUT,
                description:
                  "Answer by calling this tool once, with your whole answer as its input. Don't answer in text.",
                input_schema: answerSchema as BetaTool["input_schema"],
              },
            ]
          : []),
      ];
      const forced = Boolean(answerSchema && compat?.toolChoiceAny);
      // `none`: thinking off where the model allows it, `low` elsewhere. With thinking off a compatible
      // endpoint gets no effort: MiniMax takes one only on the model that always thinks. A forced tool is refused
      // while the model thinks, so that answer goes without thinking, or unforced on a model that always thinks.
      const thinkingOff = (request.effort === "none" || forced) && info?.leastThinking === "off";
      const asked = thinkingOff && compat ? undefined : request.effort === "none" ? "low" : request.effort;
      const effort = compat && asked === "medium" ? "high" : asked;
      const partial: PartialUsage = {
        inputTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: null,
        outputChars: 0,
      };
      const textOnly = Boolean(compat && !compat.images);
      const leftOut = textOnly && hasToolImages(request.messages);
      const params = (withThinking: boolean) => {
        // `block_binding` is taken only with thinking on; the call made without thinking goes plain.
        const bind = withThinking && !compat && !thinkingOff;
        const betas = [
          ...(fallback ? ["server-side-fallback-2026-07-01"] : []),
          ...(bind ? [THINKING_BINDING_BETA] : []),
        ];
        return {
          model: request.model,
          max_tokens: request.maxTokens,
          system: toSystem(request, compat ? undefined : room(request)),
          // Another company's endpoint (DeepSeek, Kimi, Z.ai, MiniMax) isn't trusted to take images, unless it says it does.
          messages: toMessageParams(
            textOnly ? withoutImages(request.messages, request.model) : request.messages,
            id,
            withThinking,
            // The system's breakpoints stay 5-minute ones on another company's endpoint; a longer one after them is refused.
            compat ? { type: "ephemeral" } : cacheControl(request),
          ),
          ...(compat ? {} : { cache_control: { type: "ephemeral" as const } }),
          ...(tools.length > 0 ? { tools } : {}),
          ...(forced && thinkingOff ? { tool_choice: { type: "any" as const } } : {}),
          ...(thinkingOff
            ? { thinking: { type: "disabled" as const } }
            : bind
              ? {
                  thinking: {
                    type: "adaptive" as const,
                    block_binding: { prefix_mismatch_behavior: "drop_block" as const },
                  },
                }
              : {}),
          ...(format || effort
            ? {
                output_config: {
                  ...(format ? { format: { type: "json_schema" as const, schema: format } } : {}),
                  ...(effort ? { effort } : {}),
                },
              }
            : {}),
          ...(betas.length > 0 ? { betas } : {}),
          ...(fallback ? { fallbacks: "default" as const } : {}),
        };
      };
      // Pre-warm (`maxTokens` 0): the API writes the prompt to the cache and answers nothing, billing no output.
      if (request.maxTokens === 0 && !compat) {
        try {
          const message = await client(apiKey, workspaceId).beta.messages.create(
            { ...params(true), max_tokens: 0, stream: false },
            { signal: request.signal },
          );
          return {
            text: "",
            content: [],
            model: message.model,
            stopReason: "max_tokens",
            usage: {
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens,
              cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
              ...((message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0
                ? { cacheWriteLongTokens: message.usage.cache_creation?.ephemeral_1h_input_tokens }
                : {}),
            },
          };
        } catch (error) {
          throw toProviderError(error);
        }
      }
      const call = async (withThinking: boolean): Promise<ModelResult> => {
        const stream = client(apiKey, workspaceId).beta.messages.stream(params(withThinking), {
          signal: request.signal,
        });
        stream.on("streamEvent", (event) => {
          if (event.type === "message_start") {
            partial.inputTokens = event.message.usage.input_tokens;
            partial.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
            partial.cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
            const long = event.message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
            if (long > 0) partial.cacheWriteLongTokens = long;
          } else if (event.type === "message_delta") {
            partial.outputTokens = event.usage.output_tokens;
          } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
            partial.outputChars += event.delta.partial_json.length;
          }
        });
        stream.on("text", (delta) => {
          partial.outputChars += delta.length;
          onDelta(delta);
        });
        const message = await stream.finalMessage();
        const dropped: Record<string, number> = {};
        for (const t of message.input_transformations ?? [])
          if (t.type === "thinking_dropped") dropped[t.reason] = (dropped[t.reason] ?? 0) + 1;
        const blocks = message.content.map((b) => fromContentBlock(b, id));
        const answer = answerSchema ? blocks.find(isAnswer) : undefined;
        // The answer as `output_config.format` gives it: the JSON as the only text, after any thinking.
        const content: ContentBlock[] = answer
          ? [...blocks.filter((b) => b.type === "opaque"), { type: "text", text: JSON.stringify(answer.input) }]
          : blocks;
        // Only a prefix mismatch takes the later blocks with it; one another model wrote (a fallback) goes alone.
        const [first] = content;
        if (first && (!withThinking || dropped.prefix_binding_mismatch)) first.restart = id;
        return {
          text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
          content,
          model: message.model,
          stopReason: answer ? "end_turn" : mapStopReason(message.stop_reason),
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
            ...((message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0
              ? { cacheWriteLongTokens: message.usage.cache_creation?.ephemeral_1h_input_tokens }
              : {}),
          },
          ...(Object.keys(dropped).length > 0 ? { thinking: { dropped } } : {}),
          ...(leftOut ? { imagesLeftOut: true as const } : {}),
        };
      };
      const failure = (error: unknown) => {
        const mapped = toProviderError(error);
        if (partial.inputTokens !== null || partial.outputChars > 0) mapped.partial = partial;
        return mapped;
      };
      let refused: string;
      try {
        return await call(true);
      } catch (error) {
        if (!refusesThinking(error)) throw failure(error);
        refused = toProviderError(error).message;
      }
      try {
        return { ...(await call(false)), thinking: { refused } };
      } catch (error) {
        const last = failure(error);
        throw new ProviderError(
          `${refused} (sent again without its thinking: ${last.message})`,
          last.retryable,
          last.status,
          last.partial,
          last.said,
        );
      }
    },

    ...(compat
      ? {}
      : {
          async countTokens(request: ModelRequest, { apiKey, workspaceId }: { apiKey: string; workspaceId?: string }) {
            try {
              const result = await client(apiKey, workspaceId).beta.messages.countTokens({
                model: request.model,
                system: toSystem(request),
                messages: toMessageParams(request.messages, id),
                ...(request.tools && request.tools.length > 0 ? { tools: toTools(request.tools, true) } : {}),
              });
              return result.input_tokens;
            } catch (error) {
              throw toProviderError(error);
            }
          },
        }),
  };
}

const isAnswer = (b: ContentBlock): b is Extract<ContentBlock, { type: "tool_use" }> =>
  b.type === "tool_use" && b.name === STRUCTURED_OUTPUT;

/** Breakpoints a request may carry. */
const MAX_BREAKPOINTS = 4;

type CacheControl = { type: "ephemeral"; ttl?: "1h" };

const cacheControl = (request: ModelRequest): CacheControl =>
  request.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

/** The system's breakpoints: what is left after the automatic one, the stable tools' one and the history's. */
const room = (request: ModelRequest) => ({
  control: cacheControl(request),
  max:
    MAX_BREAKPOINTS -
    1 -
    (request.tools?.some((t) => t.stable) ? 1 : 0) -
    (request.messages.some((m) => typeof m.content !== "string" && m.content.some((b) => b.type === "text" && b.cache))
      ? 1
      : 0),
});

/**
 * The system as blocks, a breakpoint after each one marked `cache` (the latest `max` of them, so the request stays
 * within the 4 allowed). Without `breakpoints` (another company's endpoint) they stay plain 5-minute ones.
 */
function toSystem(request: ModelRequest, breakpoints?: { control: CacheControl; max: number }): BetaTextBlockParam[] {
  const control = breakpoints?.control ?? { type: "ephemeral" as const };
  if (typeof request.system === "string") {
    return [{ type: "text", text: request.system, cache_control: control }];
  }
  const blocks = request.system.filter((b) => b.text.length > 0);
  const marked = blocks.filter((b) => b.cache);
  const kept = new Set(breakpoints ? marked.slice(Math.max(0, marked.length - breakpoints.max)) : marked);
  return blocks.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(kept.has(b) ? { cache_control: control } : {}),
  }));
}

/**
 * The stable tools first, then the others, each part by name; `control`: a breakpoint after the last stable tool
 * (another company's endpoint gets none).
 */
function toTools(tools: ToolSpec[], eager: boolean, control?: CacheControl): BetaTool[] {
  const ordered = stableToolsFirst(tools);
  const last = ordered.filter((t) => t.stable).length - 1;
  return ordered.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as BetaTool["input_schema"],
    ...(eager ? { eager_input_streaming: true } : {}),
    ...(control && i === last ? { cache_control: control } : {}),
  }));
}

const isThinking = (data: Record<string, unknown>) => data.type === "thinking" || data.type === "redacted_thinking";

/**
 * The messages as sent: the thinking before the last `restart` is left out, and all of it without
 * `withThinking`. A message left empty goes too (the API merges the turns around it).
 */
function toMessageParams(
  messages: ModelMessage[],
  provider: string,
  withThinking = true,
  control: CacheControl = { type: "ephemeral" },
): BetaMessageParam[] {
  let from = 0;
  messages.forEach((m, i) => {
    if (typeof m.content !== "string" && m.content.some((b) => b.restart === provider)) from = i;
  });
  return messages
    .map((m, i) => toMessageParam(m, provider, withThinking && i >= from, control))
    .filter((m) => typeof m.content === "string" || m.content.length > 0);
}

function toMessageParam(
  message: ModelMessage,
  provider: string,
  thinking: boolean,
  control: CacheControl,
): BetaMessageParam {
  if (typeof message.content === "string") return { role: message.role, content: message.content };
  return { role: message.role, content: message.content.flatMap((b) => toBlockParam(b, provider, thinking, control)) };
}

function toBlockParam(
  block: ContentBlock,
  provider: string,
  thinking: boolean,
  control: CacheControl,
): BetaContentBlockParam[] {
  switch (block.type) {
    case "text":
      // The history's end keeps the prompt's TTL: a message after a pause still reads the conversation (token-trim B8).
      return [{ type: "text", text: block.text, ...(block.cache ? { cache_control: control } : {}) }];
    case "tool_use":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    case "tool_result":
      return [
        {
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.images?.length
            ? [
                { type: "text", text: block.content },
                ...block.images.map((i) =>
                  i.mediaType === PDF_MEDIA_TYPE
                    ? {
                        type: "document" as const,
                        source: { type: "base64" as const, media_type: PDF_MEDIA_TYPE, data: i.data },
                        ...(i.name ? { title: i.name } : {}),
                      }
                    : {
                        type: "image" as const,
                        source: {
                          type: "base64" as const,
                          media_type: i.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                          data: i.data,
                        },
                      },
                ),
              ]
            : block.content,
          ...(block.isError ? { is_error: true } : {}),
        },
      ];
    case "opaque":
      // Replayed exactly as received (thinking keeps its signature); another provider's would be refused.
      if (block.provider !== provider || (!thinking && isThinking(block.data))) return [];
      return [block.data as unknown as BetaContentBlockParam];
  }
}

function fromContentBlock(block: BetaContentBlock, provider: string): ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use")
    return { type: "tool_use", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
  return { type: "opaque", provider, data: block as unknown as Record<string, unknown> };
}

/** A 400 about the thinking sent back (a signature it can't verify, a block out of place): worth a call without it. */
const refusesThinking = (error: unknown) =>
  error instanceof Anthropic.BadRequestError && /thinking|signature/i.test(error.message);

function mapStopReason(reason: string | null): StopReason {
  if (reason === "end_turn" || reason === "max_tokens" || reason === "refusal" || reason === "tool_use") return reason;
  return "other";
}

/** What the API said about a refused request. */
function saidIn(error: InstanceType<typeof Anthropic.APIError>) {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  return (typeof body?.error?.message === "string" && shortSaid(body.error.message)) || undefined;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  // Most specific first: rate limits and server errors are worth retrying, bad requests and auth are not.
  if (error instanceof Anthropic.RateLimitError) return new ProviderError("rate limited by provider", true, 429);
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError("invalid provider API key", false, 401);
  if (error instanceof Anthropic.PermissionDeniedError) return deniedError(error.type, saidIn(error));
  if (error instanceof Anthropic.InternalServerError) return new ProviderError("provider error", true, error.status);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("provider timed out", true);
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError("could not reach provider", true);
  if (error instanceof Anthropic.APIUserAbortError) return new ProviderError("request aborted", false);
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const said = saidIn(error);
    // Failed mid-stream with no words: the request was taken, so nothing says it was refused.
    if (status === undefined && !said && !error.type) return new ProviderError("provider error", true);
    const what = [status ?? "?", error.type].filter(Boolean).join(" ");
    return new ProviderError(
      `provider rejected the request (${what})${said ? `: ${said}` : ""}`,
      status === 529,
      status,
      undefined,
      said,
    );
  }
  // With eager input streaming a tool input can arrive as unparseable JSON: retrying the turn is the fix.
  if (error instanceof Anthropic.AnthropicError || error instanceof SyntaxError) {
    return new ProviderError(`could not read the model's reply: ${error.message}`, true);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), false);
}
