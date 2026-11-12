import { afterEach, describe, expect, test } from "bun:test";
import {
  boundedFetch,
  costNanoUsd,
  createCustomProvider,
  createModelProviders,
  customModelId,
  customModelOf,
  isOpenRouterModel,
  listEndpointModels,
  maxCostNanoUsd,
  modelInfo,
  modelProvider,
  outputTokensWithin,
  ProviderError,
  parseCustomModel,
  parseEndpointModels,
  setCustomModels,
} from "../src";
import { scripted, sse } from "./scripted";

const CRED = "0b9c8a52-4c1f-4f7e-9a11-7d0f2b6c3e10";
const ORG = "org-a";
const id = customModelId(CRED, "meta-llama/llama-4:70b");

afterEach(() => setCustomModels(ORG, {}));

const unpriced = {
  provider: "custom" as const,
  label: "llama",
  prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  serverSideFallback: false,
  unpriced: true as const,
};

describe("ids and the registry", () => {
  test("a custom id keeps its credential and the endpoint's own id, slashes and colons included", () => {
    expect(parseCustomModel(id)).toEqual({ credentialId: CRED, model: "meta-llama/llama-4:70b" });
    expect(parseCustomModel("claude-sonnet-5-5")).toBeNull();
    expect(modelProvider(id)).toBe("custom");
    expect(isOpenRouterModel(id)).toBe(false);
    expect(isOpenRouterModel("~z-ai/glm-latest")).toBe(true);
  });

  test("an organization's models are its own; an unpriced one costs 0 and never limits the output by money", () => {
    setCustomModels(ORG, { [id]: unpriced });
    expect(customModelOf(ORG, id)?.label).toBe("llama");
    expect(customModelOf("org-b", id)).toBeUndefined();
    expect(modelInfo(id)?.unpriced).toBe(true);
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costNanoUsd(id, usage)).toBe(0);
    expect(maxCostNanoUsd(id, 1000, 4000)).toBe(0);
    expect(outputTokensWithin(id, 1000, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(outputTokensWithin(id, 1000, 0)).toBe(0);
    setCustomModels(ORG, {});
    expect(customModelOf(ORG, id)).toBeUndefined();
    // A call that started before the model was removed still settles its cost.
    expect(costNanoUsd(id, usage)).toBe(0);
  });

  test("the server registers one custom adapter", () => {
    expect(createModelProviders().custom?.id).toBe("custom");
  });
});

describe("model lists", () => {
  test("OpenAI's and Anthropic's shape, Ollama's own, junk and repeats dropped", () => {
    expect(
      parseEndpointModels({
        data: [{ id: "gpt-x" }, { id: "claude-y", display_name: "Claude Y" }, { id: "bad id" }, { id: "gpt-x" }, 3],
      }),
    ).toEqual([{ id: "gpt-x" }, { id: "claude-y", label: "Claude Y" }]);
    expect(parseEndpointModels({ models: [{ name: "llama3:8b" }, { model: "qwen3" }] })).toEqual([
      { id: "llama3:8b" },
      { id: "qwen3" },
    ]);
    expect(parseEndpointModels("nope")).toEqual([]);
  });

  test("the list's address and key by style; a refusal and an oversized list fail with words", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const answer = (body: string, status = 200) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(body, { status });
      }) as unknown as typeof fetch;
    const ok = answer(JSON.stringify({ data: [{ id: "m1" }] }));
    expect(await listEndpointModels({ style: "openai", baseURL: "https://gw.example/v1" }, "k-123456789", ok)).toEqual([
      { id: "m1" },
    ]);
    await listEndpointModels({ style: "anthropic", baseURL: "https://gw.example/anthropic" }, "k-123456789", ok);
    await listEndpointModels({ style: "openai-responses", baseURL: "https://gw.example/v1" }, "k-123456789", ok);
    expect(seen[0]?.url).toBe("https://gw.example/v1/models");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer k-123456789");
    expect(seen[1]?.url).toBe("https://gw.example/anthropic/v1/models");
    expect(seen[1]?.headers.get("x-api-key")).toBe("k-123456789");
    expect(seen[2]?.url).toBe("https://gw.example/v1/models");
    expect(seen[2]?.headers.get("authorization")).toBe("Bearer k-123456789");
    const refused = listEndpointModels({ style: "openai", baseURL: "https://gw.example/v1" }, "k", answer("", 401));
    await expect(refused).rejects.toThrow("the provider answered 401");
    const huge = answer(JSON.stringify({ data: [{ id: "x".repeat(2_100_000) }] }));
    await expect(listEndpointModels({ style: "openai", baseURL: "https://gw.example/v1" }, "k", huge)).rejects.toThrow(
      "too large",
    );
  });
});

const chat = (chunks: Record<string, unknown>[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, ...c })}\n\n`).join("")}data: [DONE]\n\n`;

/** An SSE body of Responses API events (the OpenAI SDK reads `sequence_number`), as the endpoint streams them. */
const responsesSse = (events: Record<string, unknown>[]) =>
  events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("");

const responseOf = (extra: Record<string, unknown>) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-6-sol",
  status: "completed",
  incomplete_details: null,
  output: [],
  usage: {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 19,
  },
  ...extra,
});

describe("calls", () => {
  test("Chat Completions: the endpoint's address and model id, no OpenRouter extras, usage asked, its cost ignored", async () => {
    const { fetcher, requests } = scripted(
      chat([
        { model: "claude-sonnet-5-5", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 9 } },
      ]),
    );
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100, effort: "high" },
      { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta: () => {} },
    );
    const req = requests[0];
    expect(req?.url).toBe("https://gw.example/v1/chat/completions");
    expect(req?.headers.get("http-referer")).toBeNull();
    expect(req?.body).toMatchObject({ model: "meta-llama/llama-4:70b", stream_options: { include_usage: true } });
    expect(req?.body.reasoning).toBeUndefined();
    expect(req?.body.provider).toBeUndefined();
    // The endpoint said a catalog id answered: the full id comes back, so the catalog's prices never apply.
    expect(result.model).toBe(id);
    expect(result.costNanoUsd).toBeUndefined();
    expect(result.usage.inputTokens).toBe(10);
    // Any other endpoint: no session of ours, the SDK's own User-Agent.
    expect(req?.headers.get("x-opencode-session")).toBeNull();
    expect(req?.headers.get("user-agent")).not.toStartWith("agentes.chat/");
  });

  test("OpenCode (its Go plan): our User-Agent and the conversation's session on every call, both APIs", async () => {
    const done = chat([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const go = scripted(done);
    const provider = createCustomProvider({ fetch: go.fetcher, maxRetries: 0, version: "2026.11.07.9" });
    const call = (session?: string) =>
      provider.stream(
        {
          model: customModelId(CRED, "deepseek-v4.1-flash"),
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 100,
        },
        {
          apiKey: "oc_sk_test-key",
          endpoint: { style: "openai", baseURL: "https://opencode.ai/zen/go/v1" },
          ...(session ? { session } : {}),
          onDelta: () => {},
        },
      );
    await call("5f0c2c1e-0000-5000-8000-000000000001");
    await call();
    const [first, second] = go.requests;
    expect(first?.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(first?.headers.get("x-opencode-session")).toBe("5f0c2c1e-0000-5000-8000-000000000001");
    expect(first?.headers.get("user-agent")).toBe("agentes.chat/2026.11.07.9");
    // A call of no conversation (the connect dialog's test of each model) is a session of its own.
    expect(second?.headers.get("x-opencode-session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.headers.get("user-agent")).toBe("agentes.chat/2026.11.07.9");
    const messages = scripted(
      sse([
        {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "x",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );
    await createCustomProvider({ fetch: messages.fetcher, maxRetries: 0 }).stream(
      {
        model: customModelId(CRED, "minimax-m3"),
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
      },
      {
        apiKey: "oc_sk_test-key",
        endpoint: { style: "anthropic", baseURL: "https://opencode.ai/inference/go/anthropic" },
        session: "conversation-1",
        onDelta() {},
      },
    );
    expect(messages.requests[0]?.headers.get("x-opencode-session")).toBe("conversation-1");
    expect(messages.requests[0]?.headers.get("user-agent")).toBe("agentes.chat/dev");
  });

  test("Anthropic Messages in its compatible mode; a refusal keeps the server's words", async () => {
    const { fetcher, requests } = scripted(
      sse([
        {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "x",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );
    await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      {
        apiKey: "k-123456789",
        endpoint: { style: "anthropic", baseURL: "https://gw.example/anthropic" },
        onDelta() {},
      },
    );
    expect(requests[0]?.url).toStartWith("https://gw.example/anthropic/v1/messages");
    expect(requests[0]?.body.model).toBe("meta-llama/llama-4:70b");
    expect(requests[0]?.body.cache_control).toBeUndefined();

    const refused = scripted(JSON.stringify({ error: { message: "model llama-9 not found" } }), 404);
    const error = await createCustomProvider({ fetch: refused.fetcher, maxRetries: 0 })
      .stream(
        { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
        { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta() {} },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("model llama-9 not found");
  });

  test("a tool result's image goes to Claude on an Anthropic-compatible endpoint, never to another company's model", async () => {
    const reply = sse([
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "x",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const messages = [
      { role: "user" as const, content: "what is in the file?" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "read_file", input: {} }] },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "t1",
            content: "shot.png",
            images: [{ mediaType: "image/png", data: "UE5H" }],
          },
        ],
      },
    ];
    const send = async (model: string) => {
      const { fetcher, requests } = scripted(reply);
      const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
        { model: customModelId(CRED, model), system: "s", messages, maxTokens: 100 },
        {
          apiKey: "k-123456789",
          endpoint: { style: "anthropic", baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic" },
          onDelta() {},
        },
      );
      return { body: JSON.stringify(requests[0]?.body.messages), leftOut: result.imagesLeftOut };
    };
    const claude = await send("global.anthropic.claude-sonnet-5-5");
    expect(claude.body).toContain('"type":"image"');
    expect(claude.leftOut).toBeUndefined();
    const other = await send("moonshotai.kimi-k2.5");
    expect(other.leftOut).toBe(true);
    expect(other.body).not.toContain('"type":"image"');
    expect(other.body).toContain(
      "The picture is not shown to you: this agent's AI (moonshotai.kimi-k2.5) reads text only",
    );
  });

  test("Responses API: its own path, the endpoint's model id, tools with no `max_tokens`, text and tool calls back, its cost ignored", async () => {
    const message = {
      type: "message",
      id: "m1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Looking.", annotations: [] }],
    };
    const call = {
      type: "function_call",
      id: "fc1",
      call_id: "call_1",
      name: "get_time",
      arguments: '{"zone":"UTC"}',
      status: "completed",
    };
    const { fetcher, requests } = scripted(
      responsesSse([
        { type: "response.created", response: responseOf({ status: "in_progress" }) },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          delta: "Looking.",
          logprobs: [],
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...call, arguments: "", status: "in_progress" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 1, delta: '{"zone":"UTC"}' },
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.completed", response: responseOf({ output: [message, call] }) },
      ]),
    );
    const deltas: string[] = [];
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      {
        model: customModelId(CRED, "openai.gpt-6.1-sol"),
        system: "s",
        messages: [{ role: "user", content: "what time is it?" }],
        maxTokens: 100,
        effort: "high",
        tools: [{ name: "get_time", description: "The time", inputSchema: { type: "object" } }],
      },
      {
        apiKey: "k-123456789",
        endpoint: { style: "openai-responses", baseURL: "https://gw.example/openai/v1" },
        onDelta: (d) => deltas.push(d),
      },
    );
    const req = requests[0];
    expect(req?.url).toBe("https://gw.example/openai/v1/responses");
    expect(req?.headers.get("authorization")).toBe("Bearer k-123456789");
    expect(req?.body).toMatchObject({
      model: "openai.gpt-6.1-sol",
      instructions: "s",
      max_output_tokens: 100,
      store: false,
      stream: true,
    });
    // The Chat Completions parameters some models refuse there are never sent; an endpoint's model has no catalog
    // entry, so no `reasoning.effort` is made up for it.
    expect(req?.body.max_tokens).toBeUndefined();
    expect(req?.body.reasoning).toBeUndefined();
    expect(((req?.body.tools ?? []) as { name: string }[]).map((t) => t.name)).toEqual(["get_time"]);
    expect(deltas.join("")).toBe("Looking.");
    expect(result.text).toBe("Looking.");
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toContainEqual({ type: "tool_use", id: "call_1", name: "get_time", input: { zone: "UTC" } });
    expect(result.usage.inputTokens).toBe(12);
    // The full `custom:` id comes back and no cost of the endpoint's own counts.
    expect(result.model).toBe(customModelId(CRED, "openai.gpt-6.1-sol"));
    expect(result.costNanoUsd).toBeUndefined();
    // Anything else on the wire says so: this style never falls back to Chat Completions.
    expect(requests).toHaveLength(1);
  });

  test("tool calls without an index, or with object arguments, stay apart and readable", async () => {
    const { fetcher } = scripted(
      chat([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { id: "a", function: { name: "one", arguments: { x: 1 } } },
                  { id: "b", function: { name: "two", arguments: '{"y":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ function: { arguments: "2}" } }] }, finish_reason: "tool_calls" },
          ],
        },
      ]),
    );
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta: () => {} },
    );
    expect(result.content.filter((b) => b.type === "tool_use")).toEqual([
      { type: "tool_use", id: "a", name: "one", input: { x: 1 } },
      { type: "tool_use", id: "b", name: "two", input: { y: 2 } },
    ]);
  });

  test("an endpoint's reply is cut past its size and its time", async () => {
    const endless = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (init?.signal?.aborted) controller.error(init.signal.reason);
            else controller.enqueue(new Uint8Array(1000));
          },
        }),
      )) as unknown as typeof fetch;
    const big = await boundedFetch(endless, { maxBytes: 5000, timeoutMs: 60_000 })("https://gw.example/v1");
    await expect(big.text()).rejects.toThrow("too large");
    const silent = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
      )) as unknown as typeof fetch;
    const slow = await boundedFetch(silent, { maxBytes: 5000, timeoutMs: 20 })("https://gw.example/v1");
    await expect(slow.text()).rejects.toThrow();
  });

  test("a call without an endpoint fails", async () => {
    const call = createCustomProvider().stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 1 },
      { apiKey: "k", onDelta() {} },
    );
    await expect(call).rejects.toThrow("no endpoint");
  });
});
