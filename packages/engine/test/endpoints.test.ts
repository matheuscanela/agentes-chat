import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { customModelId, ProviderError } from "@agenteschat/providers";
import {
  agentAiState,
  allowsPrivateEndpoints,
  BudgetExceededError,
  checkEndpoint,
  createAgent,
  createCredential,
  type EndpointModel,
  endpointAddress,
  endpointPricesFromUsd,
  listCredentials,
  listEndpoint,
  modelInfoFor,
  pickerModels,
  updateAgent,
  updateEndpointModels,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

/** DNS as a test sees it: `gw.example` is public, `inside.example` resolves to a private address. */
const resolveHost = async (host: string) =>
  host === "inside.example" ? ["10.0.0.7"] : host === "meta.example" ? ["169.254.169.254"] : ["93.184.216.34"];
const cloud = { allowPrivate: false, resolveHost };
const selfHost = { allowPrivate: true, resolveHost };

const addEndpoint = (
  fx: Fixture,
  models: EndpointModel[] = [{ id: "llama-4", prices: endpointPricesFromUsd({ input: 1, output: 2 }) }],
) =>
  createCredential(
    fx.db,
    fx.keyWrapper,
    fx.owner.id,
    fx.org.id,
    {
      provider: "custom",
      label: "OpenGateway",
      apiKey: "gw-key-1234567",
      endpoint: { style: "openai", baseURL: "https://gw.example/v1/chat/completions/", models },
    },
    { net: cloud },
  );

describe("the address", () => {
  test("the Cloud refuses http, internal names, private and metadata addresses; self-host allows them", async () => {
    for (const raw of [
      "http://gw.example/v1",
      "https://localhost:11434/v1",
      "https://inside.example/v1",
      "https://meta.example/v1",
      "https://10.1.2.3/v1",
    ]) {
      await expect(endpointAddress(raw, "openai", cloud)).rejects.toThrow();
    }
    expect(await endpointAddress("http://localhost:11434/v1/", "openai", selfHost)).toBe("http://localhost:11434/v1");
    await expect(endpointAddress("ftp://x.example", "openai", selfHost)).rejects.toThrow();
    await expect(endpointAddress("https://u:p@gw.example/v1", "openai", selfHost)).rejects.toThrow();
  });

  test("the path the SDK adds is left out", async () => {
    expect(await endpointAddress("https://gw.example/v1/chat/completions?x=1", "openai", cloud)).toBe(
      "https://gw.example/v1",
    );
    expect(await endpointAddress("https://gw.example/anthropic/v1/messages", "anthropic", cloud)).toBe(
      "https://gw.example/anthropic",
    );
    expect(await endpointAddress("https://gw.example/openai/v1/responses?x=1", "openai-responses", cloud)).toBe(
      "https://gw.example/openai/v1",
    );
    // Each style cuts only its own path: Chat Completions' stays on a Responses address, and the reverse.
    expect(await endpointAddress("https://gw.example/v1/chat/completions", "openai-responses", cloud)).toBe(
      "https://gw.example/v1/chat/completions",
    );
    expect(await endpointAddress("https://gw.example/v1/responses", "openai", cloud)).toBe(
      "https://gw.example/v1/responses",
    );
  });

  test("private addresses: on by default, off on agentes.chat Cloud, the flag wins", () => {
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://chat.example.com" })).toBe(true);
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://app.agentes.chat" })).toBe(false);
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://chat.example.com", ALLOW_SIGNUP: true })).toBe(false);
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://chat.example.com", MODEL_ENDPOINTS_PRIVATE: false })).toBe(
      false,
    );
  });
});

describe("the credential", () => {
  test("admins only; the endpoint is required, its models checked, the key sealed and never shown", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const input = {
      provider: "custom" as const,
      label: "GW",
      apiKey: "gw-key-1234567",
      endpoint: { style: "openai" as const, baseURL: "https://gw.example/v1", models: [{ id: "m" }] },
    };
    await expect(createCredential(f.db, f.keyWrapper, member.id, f.org.id, input, { net: cloud })).rejects.toThrow();
    await expect(
      createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, { ...input, endpoint: undefined }, { net: cloud }),
    ).rejects.toThrow("endpoint");
    await expect(
      createCredential(
        f.db,
        f.keyWrapper,
        f.owner.id,
        f.org.id,
        { ...input, endpoint: { ...input.endpoint, models: [] } },
        { net: cloud },
      ),
    ).rejects.toThrow("at least one model");
    const saved = await addEndpoint(f);
    expect(saved.endpoint).toEqual({
      style: "openai",
      baseURL: "https://gw.example/v1",
      models: [{ id: "llama-4", prices: { input: 1000, output: 2000, cacheRead: 1000, cacheWrite: 1000 } }],
    });
    expect(JSON.stringify(await listCredentials(f.db, f.owner.id, f.org.id))).not.toContain("gw-key-1234567");
    const [row] = await f.db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.id, saved.id));
    expect(row?.secretCiphertext).not.toContain("gw-key");
  });

  test("a key-less server (a local Ollama) is saved with no key hint", async () => {
    f = await setup();
    const saved = await createCredential(
      f.db,
      f.keyWrapper,
      f.owner.id,
      f.org.id,
      {
        provider: "custom",
        label: "Ollama",
        apiKey: "",
        endpoint: { style: "openai", baseURL: "http://localhost:11434/v1", models: [{ id: "qwen3:8b" }] },
      },
      { net: selfHost },
    );
    expect(saved.keyHint).toBe("");
  });

  test("the list before saving: the models, or why there are none", async () => {
    f = await setup();
    const ok = (async () =>
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }))) as unknown as typeof fetch;
    expect(
      await listEndpoint(
        f.db,
        f.owner.id,
        f.org.id,
        { style: "openai", baseURL: "https://gw.example/v1", apiKey: "k" },
        { ...cloud, fetch: ok },
      ),
    ).toEqual({ baseURL: "https://gw.example/v1", models: [{ id: "a" }, { id: "b" }] });
    const down = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const r = await listEndpoint(
      f.db,
      f.owner.id,
      f.org.id,
      { style: "openai", baseURL: "https://gw.example/v1" },
      { ...cloud, fetch: down },
    );
    expect(r.models).toEqual([]);
    expect(r.error).toContain("404");
    await expect(
      listEndpoint(f.db, f.owner.id, f.org.id, { style: "openai", baseURL: "https://inside.example/v1" }, cloud),
    ).rejects.toThrow("internal network");
  });
});

describe("calls", () => {
  test("an endpoint key alone repairs an Automatic agent; explicit models are preserved", async () => {
    f = await setup();
    const cred = await addEndpoint(f, [{ id: "first" }, { id: "chosen" }]);
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto" });
    const connected = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: cred.id });
    expect(connected.model).toBe(customModelId(cred.id, "first"));
    const explicit = customModelId(cred.id, "chosen");
    const selected = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: explicit });
    expect(selected.model).toBe(explicit);
    const reconnected = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: cred.id });
    expect(reconnected.model).toBe(explicit);
    const automatic = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto" });
    expect(automatic.model).toBe(customModelId(cred.id, "first"));
  });

  test("new agents with an endpoint key use its model, while catalog keys keep Automatic", async () => {
    f = await setup();
    const cred = await addEndpoint(f);
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Endpoint", handle: "endpoint-agent", credentialId: cred.id },
      { model: "auto" },
    );
    expect(agent.model).toBe(customModelId(cred.id, "llama-4"));
    const catalog = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto" });
    expect(catalog.model).toBe("auto");
  });

  test("connecting an endpoint on Automatic selects its own model and can answer", async () => {
    f = await setup();
    const cred = await addEndpoint(f);
    const agent = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, {
      model: "auto",
      credentialId: cred.id,
    });
    expect(agent.model).toBe(customModelId(cred.id, "llama-4"));
    expect(await agentAiState({ db: f.db, gateway: f.gateway }, agent)).toMatchObject({ state: "ready" });
    await f.gateway.stream({
      orgId: f.org.id,
      agentId: agent.id,
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      onDelta() {},
    });
    expect(f.provider.calls.at(-1)?.request.model).toBe(agent.model);
    expect(f.provider.calls.at(-1)?.endpoint).toEqual({ style: "openai", baseURL: "https://gw.example/v1" });
  });

  test("an agent on an endpoint model: its key and address, the admin's prices, tokens and cost recorded", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    const cred = await addEndpoint(f);
    const model = customModelId(cred.id, "llama-4");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model, credentialId: cred.id });
    const result = await f.gateway.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      onDelta() {},
    });
    const sent = f.provider.calls.at(-1);
    expect(sent?.apiKey).toBe("gw-key-1234567");
    expect(sent?.endpoint).toEqual({ style: "openai", baseURL: "https://gw.example/v1" });
    expect(result.costNanoUsd).toBe(1000 * 1000 + 100 * 2000);
    const [record] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, f.agent.id));
    expect(record).toMatchObject({ provider: "custom", model, credentialId: cred.id, orgId: f.org.id });
  });

  test("an unpriced model: cost 0 with its tokens, so a budget never stops it; a priced one is stopped", async () => {
    f = await setup({
      budgetNanoUsd: 1,
      reply: () => ({ chunks: ["ok"], usage: { inputTokens: 500, outputTokens: 50 } }),
    });
    const cred = await addEndpoint(f, [
      { id: "free-model" },
      { id: "paid", prices: endpointPricesFromUsd({ input: 5, output: 5 }) },
    ]);
    const run = (model: string) =>
      updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model, credentialId: cred.id }).then(() =>
        f.gateway.stream({
          orgId: f.org.id,
          agentId: f.agent.id,
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 100,
          onDelta() {},
        }),
      );
    const free = await run(customModelId(cred.id, "free-model"));
    expect(free.costNanoUsd).toBe(0);
    const [record] = await f.db.select().from(schema.usageRecords);
    expect(record).toMatchObject({ inputTokens: 500, outputTokens: 50, costNanoUsd: 0 });
    await expect(run(customModelId(cred.id, "paid"))).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("another workspace's endpoint model is unknown here", async () => {
    f = await setup();
    const cred = await addEndpoint(f);
    const model = customModelId(cred.id, "llama-4");
    expect((await modelInfoFor(f.db, model, f.org.id))?.endpoint).toBe("OpenGateway");
    expect(await modelInfoFor(f.db, model, crypto.randomUUID())).toBeUndefined();
    expect(await modelInfoFor(f.db, model)).toBeUndefined();
    expect((await pickerModels(f.db, [f.org.id])).some(([id]) => id === model)).toBe(true);
    expect((await pickerModels(f.db)).some(([id]) => id === model)).toBe(false);
    // Its model only runs on its own endpoint.
    await expect(
      updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model, credentialId: f.credential.id }),
    ).rejects.toThrow("its own endpoint");
  });
});

describe("the test call", () => {
  test("one per model with a tool: ok, no tools, or failed in the server's words; each kept and recorded", async () => {
    f = await setup({
      reply: (request) =>
        request.model.endsWith(":tools")
          ? { chunks: [], toolUses: [{ name: "report_status", input: { ok: true } }] }
          : request.model.endsWith(":broken")
            ? new ProviderError("provider rejected the request (404): model broken not found", false, 404)
            : { chunks: ["I can't call tools."] },
    });
    const cred = await addEndpoint(f, [{ id: "tools" }, { id: "chat" }, { id: "broken" }]);
    const checks = await checkEndpoint(f.db, f.gateway, f.owner.id, f.org.id, cred.id);
    expect(checks).toEqual([
      { model: "tools", check: "ok" },
      { model: "chat", check: "no_tools" },
      { model: "broken", check: "failed", error: "provider rejected the request (404): model broken not found" },
    ]);
    expect(f.provider.calls.find((c) => c.request.model.endsWith(":tools"))?.request.tools?.[0]?.name).toBe(
      "report_status",
    );
    const [saved] = (await listCredentials(f.db, f.owner.id, f.org.id)).filter((c) => c.id === cred.id);
    expect(saved?.endpoint?.models.map((m) => m.check)).toEqual(["ok", "no_tools", "failed"]);
    const rows = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.credentialId, cred.id));
    expect(rows.map((r) => r.kind)).toEqual(["summary", "summary"]);
    // Prices change, the checks stay with their models.
    const next = await updateEndpointModels(f.db, f.owner.id, f.org.id, cred.id, [
      { id: "tools", prices: endpointPricesFromUsd({ input: 1, output: 1 }) },
    ]);
    expect(next.models).toEqual([
      { id: "tools", prices: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 }, check: "ok" },
    ]);
    const member = await addMember(f.db, f.org.id, "member");
    await expect(checkEndpoint(f.db, f.gateway, member.id, f.org.id, cred.id)).rejects.toThrow();
  });
});
