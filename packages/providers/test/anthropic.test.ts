import { describe, expect, test } from "bun:test";
import { createAnthropicProvider, type ModelMessage, type ModelProvider, ProviderError } from "../src";
import { scripted, sse } from "./scripted";

const start = (input: number) => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 },
  },
});

describe("Anthropic adapter (scripted transport)", () => {
  test("maps tools, structured output, cache breakpoints, opaque replay; returns neutral blocks", async () => {
    const { fetcher, requests } = scripted(
      sse([
        start(25),
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "sig" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me check." } },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_1", name: "github__merge", input: {} },
        },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pr":42}' } },
        { type: "content_block_stop", index: 2 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 12 },
        },
        { type: "message_stop" },
      ]),
    );
    const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
    const deltas: string[] = [];
    const result = await provider.stream(
      {
        model: "claude-sonnet-5-5",
        system: [{ text: "org", cache: true }, { text: "agent", cache: true }, { text: "where" }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", data: { type: "thinking", thinking: "", signature: "abc" } },
              { type: "tool_use", id: "toolu_0", name: "search_context", input: { query: "x" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "toolu_0",
                content: "nothing",
                isError: true,
                images: [{ mediaType: "image/png", data: "UE5H" }],
              },
            ],
          },
        ],
        maxTokens: 1000,
        tools: [
          { name: "z_tool", description: "z", inputSchema: { type: "object" } },
          { name: "a_tool", description: "a", inputSchema: { type: "object" } },
        ],
        outputSchema: { type: "object" },
        effort: "low",
      },
      { apiKey: "sk-test", onDelta: (d) => deltas.push(d) },
    );

    const body = requests[0]?.body as Record<string, unknown>;
    expect(requests[0]?.headers.get("x-api-key")).toBe("sk-test");
    expect(body.system).toEqual([
      { type: "text", text: "org", cache_control: { type: "ephemeral" } },
      { type: "text", text: "agent", cache_control: { type: "ephemeral" } },
      { type: "text", text: "where" },
    ]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["a_tool", "z_tool"]);
    expect((body.tools as Record<string, unknown>[])[0]).toMatchObject({ eager_input_streaming: true });
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } }, effort: "low" });
    expect((body.messages as Record<string, unknown>[])[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "abc" },
        { type: "tool_use", id: "toolu_0", name: "search_context", input: { query: "x" } },
      ],
    });
    expect((body.messages as Record<string, unknown>[])[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_0",
          content: [
            { type: "text", text: "nothing" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "UE5H" } },
          ],
          is_error: true,
        },
      ],
    });

    expect(deltas).toEqual(["Let me check."]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.text).toBe("Let me check.");
    expect(result.content).toEqual([
      { type: "opaque", provider: "anthropic", data: { type: "thinking", thinking: "", signature: "sig" } },
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "github__merge", input: { pr: 42 } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 12, cacheReadTokens: 7, cacheWriteTokens: 0 });
  });

  test("a stream that breaks midway reports the usage seen so far", async () => {
    const { fetcher } = scripted(
      sse(
        [
          start(321),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half of" } },
        ],
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
      ),
    );
    const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
    const error = await provider
      .stream(
        { model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
        { apiKey: "k", onDelta: () => {} },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).partial).toEqual({
      inputTokens: 321,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      outputTokens: null,
      outputChars: 7,
    });
  });
});

test("a stream that fails with no words is the provider's own failure: it's retried, never \"rejected (?)\"", async () => {
  const { fetcher } = scripted(sse([start(5)], "event: error\ndata: {}\n\n"));
  const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
  const error = await provider
    .stream(
      { model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      { apiKey: "k", onDelta: () => {} },
    )
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ message: "provider error", retryable: true });
});

test("effort none: Haiku 5.5 thinks not at all at low effort; a model that can't stop thinking gets low", async () => {
  const done = sse([
    start(1),
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
  const sent = async (model: string) => {
    const { fetcher, requests } = scripted(done);
    const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
    await provider.stream(
      { model, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 512, effort: "none" },
      { apiKey: "k", onDelta: () => {} },
    );
    return requests[0]?.body as Record<string, unknown>;
  };
  const haiku = await sent("claude-haiku-5-5");
  expect(haiku.thinking).toEqual({ type: "disabled" });
  expect(haiku.output_config).toEqual({ effort: "low" });
  const sonnet = await sent("claude-sonnet-5-5");
  expect(sonnet.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  expect(sonnet.output_config).toEqual({ effort: "low" });
});

describe("preserved thinking: thinking sent back under other tools (accounts created since 2026-08-31)", () => {
  type Block = Record<string, unknown> & { type: string };
  type Body = { tools?: { name: string }[]; messages: { content: string | Block[] }[]; thinking?: unknown };
  type Reply = { thinking?: true; tool?: string; text?: string; refuse?: string };
  /** A real signature is 1.3 to 1.9 KB. */
  const PAD = "S".repeat(1500);

  /**
   * Claude's API as it treats the thinking it gets back: a block's signature names the tools it was written
   * with, and one sent back under other tools is refused unless the request asks to drop it (each drop
   * reported in `input_transformations`). A signature it can't read is always refused.
   */
  function claudeApi(replies: Reply[]) {
    const sent: { body: Body; beta: string | null }[] = [];
    const refused = (message: string) =>
      new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      sent.push({ body, beta: new Headers(init?.headers).get("anthropic-beta") });
      const tools = `tools:${(body.tools ?? []).map((t) => t.name).join(",")}`;
      const thinking = body.messages.flatMap((m, i) =>
        typeof m.content === "string"
          ? []
          : m.content.flatMap((b, j) =>
              b.type === "thinking" ? [{ signature: String(b.signature), path: `messages.${i}.content.${j}` }] : [],
            ),
      );
      const unreadable = thinking.find((b) => !b.signature.startsWith("tools:"));
      if (unreadable) return refused(`${unreadable.path}: Invalid \`signature\` in \`thinking\` block.`);
      const stale = thinking.filter((b) => !b.signature.startsWith(`${tools}|`));
      const binding = body.thinking as { block_binding?: { prefix_mismatch_behavior?: string } } | undefined;
      const drop = binding?.block_binding?.prefix_mismatch_behavior === "drop_block";
      if (stale.length > 0 && !drop) {
        return refused(
          `${stale[0]?.path}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`,
        );
      }
      const reply = replies.shift() ?? { text: "Done." };
      if (reply.refuse) return refused(reply.refuse);
      const blocks: Record<string, unknown>[] = [
        ...(reply.thinking ? [{ type: "thinking", thinking: "", signature: `${tools}|${PAD}` }] : []),
        ...(reply.text ? [{ type: "text", text: reply.text }] : []),
        ...(reply.tool ? [{ type: "tool_use", id: `toolu_${sent.length}`, name: reply.tool, input: {} }] : []),
      ];
      const transformations = stale.map((b) => ({
        type: "thinking_dropped",
        path: b.path,
        reason: "prefix_binding_mismatch",
      }));
      return new Response(
        sse([
          {
            type: "message_start",
            message: {
              ...start(10).message,
              id: `msg_${sent.length}`,
              model: "claude-haiku-5-5",
              ...(drop ? { input_transformations: transformations } : {}),
            },
          },
          ...blocks.flatMap((content_block, index) => [
            { type: "content_block_start", index, content_block },
            { type: "content_block_stop", index },
          ]),
          {
            type: "message_delta",
            delta: { stop_reason: reply.tool ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    return { fetcher, sent };
  }

  const BEFORE = ["browser_do", "browser_open", "browser_read", "find_tools", "set_status", "use_tool"];
  // The run lists its tools again before every call, and a source can answer otherwise from one call to the next
  // (the browser's tools go when its computer stops serving the browser, `browser/tools.ts`).
  const AFTER = BEFORE.filter((n) => !n.startsWith("browser_"));
  const BINDING = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
  const ask = (provider: ModelProvider, messages: ModelMessage[], tools: string[]) =>
    provider.stream(
      {
        model: "claude-haiku-5-5",
        system: [
          { text: "org", cache: true },
          { text: "agent", cache: true },
        ],
        messages,
        maxTokens: 4096,
        tools: tools.map((name) => ({ name, description: `${name}.`, inputSchema: { type: "object" } })),
        effort: "low",
      },
      { apiKey: "k", onDelta: () => {} },
    );
  const thinkingIn = (body: Body | undefined) =>
    (body?.messages ?? [])
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => b.type === "thinking");

  test("a call under tools that changed since its thinking asks the API to drop that thinking, and later calls leave it out", async () => {
    const api = claudeApi([
      { tool: "find_tools" },
      { tool: "browser_read" },
      { thinking: true, tool: "find_tools" },
      { tool: "browser_do" },
      { thinking: true, text: "My computer isn't answering, so I couldn't post it." },
      { text: "Ok." },
    ]);
    const provider = createAnthropicProvider({ fetch: api.fetcher, maxRetries: 0 });
    // Its history up to message 21 (a person's), then the run: find_tools, browser_read (the browser isn't open),
    // find_tools after thinking (message 26), browser_do (the computer isn't answering).
    const messages: ModelMessage[] = [
      { role: "user", content: "earlier" },
      ...Array.from(
        { length: 21 },
        (_, i): ModelMessage => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i + 1}`,
        }),
      ),
    ];
    const results: [string, boolean][] = [
      ["Tools: browser_open, browser_read, browser_do.", false],
      ["The browser isn't open: open a page first", true],
      ["Tools: browser_do.", false],
      ["Ada's computer isn't answering right now.", true],
    ];
    for (const [content, isError] of results) {
      const reply = await ask(provider, messages, BEFORE);
      const use = reply.content.find((b) => b.type === "tool_use");
      messages.push(
        { role: "assistant", content: reply.content },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: use?.type === "tool_use" ? use.id : "", content, isError }],
        },
      );
    }
    expect(messages[26]?.content).toMatchObject([{ type: "opaque", provider: "anthropic" }, { type: "tool_use" }]);

    const fifth = await ask(provider, messages, AFTER);
    const call = api.sent[4]?.body;
    expect(call?.tools?.map((t) => t.name)).toEqual(AFTER);
    expect(thinkingIn(call)).toEqual([
      { type: "thinking", thinking: "", signature: `tools:${BEFORE.join(",")}|${PAD}` },
    ]);
    expect(api.sent.map((s) => s.body.thinking)).toEqual(Array(5).fill(BINDING));
    expect(api.sent.every((s) => s.beta === "thinking-binding-controls-2026-08-01")).toBe(true);
    expect(fifth.text).toBe("My computer isn't answering, so I couldn't post it.");
    expect(fifth.content[0]).toMatchObject({ type: "opaque", provider: "anthropic", restart: "anthropic" });
    expect(fifth.thinking).toEqual({ dropped: { prefix_binding_mismatch: 1 } });

    // The thinking from before the drop stays out from then on; the one written after it goes back.
    messages.push({ role: "assistant", content: fifth.content }, { role: "user", content: "Try again later." });
    await ask(provider, messages, AFTER);
    const sixth = api.sent[5]?.body;
    expect(sixth?.messages[26]?.content).toEqual([{ type: "tool_use", id: "toolu_3", name: "find_tools", input: {} }]);
    expect(thinkingIn(sixth).map((b) => b.signature)).toEqual([`tools:${AFTER.join(",")}|${PAD}`]);
    expect(api.sent).toHaveLength(6);
  });

  test("thinking the API still refuses gets one more call without any, and stays out after", async () => {
    const api = claudeApi([{ thinking: true, text: "Posted." }, { text: "Ok." }]);
    const provider = createAnthropicProvider({ fetch: api.fetcher, maxRetries: 0 });
    const unreadable = { type: "thinking", thinking: "", signature: "garbled" };
    const messages: ModelMessage[] = [
      { role: "user", content: "Post it" },
      // An answer that was only its thinking, and the nudge after it.
      { role: "assistant", content: [{ type: "opaque", provider: "anthropic", data: unreadable }] },
      { role: "user", content: "You were addressed directly; answer the person." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "find_tools", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_a", content: "Tools: browser_do." }] },
    ];
    const reply = await ask(provider, messages, AFTER);
    expect(api.sent).toHaveLength(2);
    expect(thinkingIn(api.sent[0]?.body)).toEqual([unreadable]);
    // The second call sends no thinking back (a message that was only thinking goes too), nor the binding the
    // first one asked for.
    expect(api.sent[1]?.body.messages.map((m) => m.content)).toEqual([
      "Post it",
      "You were addressed directly; answer the person.",
      [{ type: "tool_use", id: "toolu_a", name: "find_tools", input: {} }],
      [{ type: "tool_result", tool_use_id: "toolu_a", content: "Tools: browser_do." }],
    ]);
    expect(api.sent[1]?.body).not.toHaveProperty("thinking");
    expect(api.sent[1]?.beta).toBeNull();
    expect(reply.text).toBe("Posted.");
    expect(reply.content[0]).toMatchObject({ type: "opaque", restart: "anthropic" });

    messages.push({ role: "assistant", content: reply.content }, { role: "user", content: "Thanks" });
    await ask(provider, messages, AFTER);
    expect(api.sent).toHaveLength(3);
    expect(thinkingIn(api.sent[2]?.body).map((b) => b.signature)).toEqual([`tools:${AFTER.join(",")}|${PAD}`]);
  });

  /** A history with thinking the API can't read: refused with or without `drop_block`. */
  const unreadableHistory = (): ModelMessage[] => [
    { role: "user", content: "Post it" },
    {
      role: "assistant",
      content: [
        { type: "opaque", provider: "anthropic", data: { type: "thinking", thinking: "", signature: "garbled" } },
        { type: "text", text: "On it." },
      ],
    },
    { role: "user", content: "Go on." },
  ];
  const REFUSAL =
    "provider rejected the request (400 invalid_request_error): messages.1.content.0: Invalid `signature` in `thinking` block.";

  test("the reply to the call without thinking marks the restart even with no thinking of its own", async () => {
    const api = claudeApi([{ tool: "find_tools" }, { text: "Posted." }]);
    const provider = createAnthropicProvider({ fetch: api.fetcher, maxRetries: 0 });
    const messages = unreadableHistory();
    const reply = await ask(provider, messages, AFTER);
    expect(api.sent).toHaveLength(2);
    expect(reply.content).toEqual([
      { type: "tool_use", id: "toolu_2", name: "find_tools", input: {}, restart: "anthropic" },
    ]);
    expect(reply.thinking).toEqual({ refused: REFUSAL });

    messages.push(
      { role: "assistant", content: reply.content },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_2", content: "Tools: browser_do." }] },
    );
    const next = await ask(provider, messages, AFTER);
    // One request, with the binding and without the refused thinking: no second call without thinking.
    expect(api.sent).toHaveLength(3);
    expect(api.sent[2]?.body.thinking).toEqual(BINDING);
    expect(thinkingIn(api.sent[2]?.body)).toEqual([]);
    expect(next.text).toBe("Posted.");
  });

  test("when the call without thinking is refused too, the error keeps the first refusal", async () => {
    const api = claudeApi([{ refuse: "prompt is too long: 1048577 tokens > 1000000 maximum" }]);
    const provider = createAnthropicProvider({ fetch: api.fetcher, maxRetries: 0 });
    const error = await ask(provider, unreadableHistory(), AFTER).catch((e: unknown) => e);
    expect(api.sent).toHaveLength(2);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      retryable: false,
      status: 400,
      message: `${REFUSAL} (sent again without its thinking: provider rejected the request (400 invalid_request_error): prompt is too long: 1048577 tokens > 1000000 maximum)`,
      said: "prompt is too long: 1048577 tokens > 1000000 maximum",
    });
  });

  test("a 403 keeps the API's words: they say why the key has no access", async () => {
    const said = "This organization has been disabled.";
    const { fetcher } = scripted(
      JSON.stringify({ type: "error", error: { type: "permission_error", message: said } }),
      403,
    );
    const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
    const error = await ask(provider, unreadableHistory(), AFTER).catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: `provider denied access (403 permission_error): ${said}`,
      status: 403,
      said,
    });
  });

  test("a refused request keeps the API's error type and words, capped; one not about thinking goes once", async () => {
    const said = `prompt is too long: 1048577 tokens > 1000000 maximum ${"x".repeat(400)}`;
    const { fetcher, requests } = scripted(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: said } }),
      400,
    );
    const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
    const error = await ask(provider, [{ role: "user", content: "hi" }], AFTER).catch((e: unknown) => e);
    expect(requests).toHaveLength(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      retryable: false,
      status: 400,
      message: `provider rejected the request (400 invalid_request_error): ${said.slice(0, 300)}`,
    });
  });
});

test("a workspace id is sent as the anthropic-workspace-id header", async () => {
  const { fetcher, requests } = scripted(
    sse([
      start(1),
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]),
  );
  const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
  await provider.stream(
    { model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
    { apiKey: "k", workspaceId: "wrkspc_123", onDelta: () => {} },
  );
  expect(requests[0]?.headers.get("anthropic-workspace-id")).toBe("wrkspc_123");
  await provider.stream(
    { model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
    { apiKey: "k", onDelta: () => {} },
  );
  expect(requests[1]?.headers.get("anthropic-workspace-id")).toBeNull();
});

describe("prompt cache: a stable prefix whatever tools load", () => {
  const tool = (name: string, stable?: boolean) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    ...(stable ? { stable: true } : {}),
  });
  const send = async (
    request: Partial<Parameters<ModelProvider["stream"]>[0]>,
    usage: Record<string, unknown> = {},
  ) => {
    const { fetcher, requests } = scripted(
      sse([
        { ...start(10), message: { ...start(10).message, usage: { ...start(10).message.usage, ...usage } } },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );
    const result = await createAnthropicProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      {
        model: "claude-sonnet-5-5",
        system: "s",
        messages: [{ role: "user", content: "oi" }],
        maxTokens: 10,
        ...request,
      },
      { apiKey: "k", onDelta: () => {} },
    );
    return { body: requests[0]?.body as Record<string, unknown>, result };
  };
  const breakpoints = (body: Record<string, unknown>) =>
    [...(body.tools as Record<string, unknown>[]), ...(body.system as Record<string, unknown>[])].filter(
      (b) => b.cache_control,
    ).length + (body.cache_control ? 1 : 0);

  test("stable tools first, a breakpoint after the last; another group loaded keeps those bytes", async () => {
    const core = [tool("search_context", true), tool("ask_user", true), tool("remember", true)];
    const a = await send({ tools: [tool("find_tools"), ...core] });
    const b = await send({ tools: [tool("list_issues"), tool("create_issue"), ...core] });
    const names = (body: Record<string, unknown>) => (body.tools as { name: string }[]).map((t) => t.name);
    expect(names(a.body)).toEqual(["ask_user", "remember", "search_context", "find_tools"]);
    expect(names(b.body)).toEqual(["ask_user", "remember", "search_context", "create_issue", "list_issues"]);
    const prefix = (body: Record<string, unknown>) => JSON.stringify((body.tools as unknown[]).slice(0, 3));
    expect(prefix(a.body)).toBe(prefix(b.body));
    expect((a.body.tools as Record<string, unknown>[])[2]?.cache_control).toEqual({ type: "ephemeral" });
    expect((a.body.tools as Record<string, unknown>[])[3]?.cache_control).toBeUndefined();
  });

  test("1h on the stable prefix, 5 min on the conversation; never more than 4 breakpoints", async () => {
    const { body, result } = await send(
      {
        cacheTtl: "1h",
        tools: [tool("a", true), tool("b")],
        system: [
          { text: "org", cache: true },
          { text: "agent", cache: true },
          { text: "settled", cache: true },
          { text: "turn" },
        ],
      },
      {
        cache_creation_input_tokens: 900,
        cache_creation: { ephemeral_1h_input_tokens: 800, ephemeral_5m_input_tokens: 100 },
      },
    );
    const hour = { type: "ephemeral", ttl: "1h" };
    expect((body.tools as Record<string, unknown>[])[0]?.cache_control).toEqual(hour);
    // The tools' breakpoint and the conversation's leave room for two in the system: the latest ones.
    expect(body.system).toEqual([
      { type: "text", text: "org" },
      { type: "text", text: "agent", cache_control: hour },
      { type: "text", text: "settled", cache_control: hour },
      { type: "text", text: "turn" },
    ]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(breakpoints(body)).toBe(4);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 7,
      cacheWriteTokens: 900,
      cacheWriteLongTokens: 800,
    });
    // Without it, the 5-minute default everywhere.
    const plain = await send({ tools: [tool("a", true)], system: [{ text: "agent", cache: true }] });
    expect((plain.body.tools as Record<string, unknown>[])[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect((plain.body.system as Record<string, unknown>[])[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("another company's endpoint: the stable tools first all the same, no tool breakpoint or 1h", async () => {
    const { fetcher, requests } = scripted(
      sse([start(1), { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }]),
    );
    await createAnthropicProvider({ fetch: fetcher, maxRetries: 0, compat: { toolChoiceAny: true } })
      .stream(
        {
          model: "deepseek-v4-pro",
          system: [{ text: "agent", cache: true }],
          messages: [
            { role: "user", content: [{ type: "text", text: "oi", cache: true }] },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_skill_file", input: {} }] },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  toolUseId: "t1",
                  content: "a/b.png",
                  images: [{ mediaType: "image/png", data: "UE5H" }],
                },
              ],
            },
          ],
          maxTokens: 10,
          cacheTtl: "1h",
          tools: [tool("z"), tool("b", true)],
        },
        { apiKey: "k", onDelta: () => {} },
      )
      .catch(() => {});
    const body = requests[0]?.body as Record<string, unknown>;
    expect((body.tools as Record<string, unknown>[]).map((t) => [t.name, t.cache_control])).toEqual([
      ["b", undefined],
      ["z", undefined],
    ]);
    expect(body.system).toEqual([{ type: "text", text: "agent", cache_control: { type: "ephemeral" } }]);
    // The history's breakpoint is a 5-minute one too: Anthropic refuses a 1-hour one after the system's 5-minute one.
    expect(JSON.stringify(body.messages)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(JSON.stringify(body)).not.toContain('"ttl"');
    // A tool result's image goes as a note: these endpoints aren't trusted to take images.
    expect(JSON.stringify(body.messages)).not.toContain('"image"');
    expect(JSON.stringify(body.messages)).toContain(
      "The picture is not shown to you: this agent's AI (deepseek-v4-pro)",
    );
  });
});
