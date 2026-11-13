import { afterEach, expect, test } from "bun:test";
import { enableOpenRouterModels, ProviderError, setOpenRouterModels } from "@agenteschat/providers";
import fixture from "../../../packages/providers/test/fixtures/openrouter-models.json";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  enableOpenRouterModels(null);
  setOpenRouterModels({}, 0);
  await t.close();
});

test("keys per provider: create as default in one call, Tornar padrão, models available per org, channel creator", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  let models = (await (await api("/models")).json()) as {
    models: { id: string; available: boolean; recommended: boolean }[];
  };
  expect(models.models.find((m) => m.id === "claude-sonnet-5-5")).toMatchObject({ available: true, recommended: true });
  expect(models.models.find((m) => m.id === "gpt-6-sol")).toMatchObject({ available: false, recommended: false });

  const created = await api("/credentials", {
    json: { provider: "openai", label: "OpenAI", apiKey: "sk-proj-abcdefgh", project: "proj_1", makeDefault: true },
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as { id: string; isDefault: boolean };
  expect(key.isDefault).toBe(true);
  const settings = (await (await api("/settings")).json()) as { defaultCredentialIds: Record<string, string> };
  expect(settings.defaultCredentialIds.openai).toBe(key.id);
  models = (await (await api("/models")).json()) as typeof models;
  expect(models.models.find((m) => m.id === "gpt-6-sol")?.available).toBe(true);

  expect((await api(`/credentials/${key.id}`, { method: "DELETE" })).status).toBe(409);
  const second = (await (
    await api("/credentials", { json: { provider: "openai", label: "b", apiKey: "sk-proj-zzzzzzzz" } })
  ).json()) as {
    id: string;
  };
  expect((await (await api(`/credentials/${second.id}/make-default`, { json: {} })).json()) as object).toMatchObject({
    isDefault: true,
  });
  expect((await api(`/credentials/${key.id}`, { method: "DELETE" })).status).toBe(204);

  const channels = (await (await api("/channels")).json()) as {
    channels: { id: string; createdByUserId: string | null }[];
  };
  expect(channels.channels.find((c) => c.id === channelId)?.createdByUserId).toBeTruthy();
});

test("an Anthropic-compatible provider's key: its models become available, and its default is set on its own", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/credentials", {
    json: { provider: "deepseek", label: "DeepSeek", apiKey: "sk-deepseek-abcdefgh" },
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as { id: string; provider: string };
  expect(key.provider).toBe("deepseek");
  const models = (await (await api("/models")).json()) as {
    models: { id: string; available: boolean; recommended: boolean }[];
    providers: { id: string; label: string; hasKey: boolean }[];
  };
  expect(models.models.find((m) => m.id === "deepseek-flash")).toMatchObject({ available: true, recommended: true });
  expect(models.models.find((m) => m.id === "glm-5.3")).toMatchObject({ available: false, recommended: false });
  expect(models.providers.find((p) => p.id === "deepseek")).toMatchObject({ label: "DeepSeek", hasKey: true });
  expect(models.providers.find((p) => p.id === "anthropic")?.label).toBe("Claude");
  const patched = await api("/settings", { method: "PATCH", json: { defaultCredentialIds: { deepseek: key.id } } });
  expect(patched.status).toBe(200);
  expect(
    ((await patched.json()) as { defaultCredentialIds: Record<string, string> }).defaultCredentialIds,
  ).toMatchObject({ deepseek: key.id });
  expect(
    (await api("/credentials", { json: { provider: "mistral", label: "x", apiKey: "abcdefgh1234" } })).status,
  ).toBe(400);
});

test("a Gemini key: Gemini third among the providers, its five models available, 3.8 Flash suggested", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/credentials", {
    json: { provider: "gemini", label: "Gemini", apiKey: "AQ.Ab8RN6Ltest-key-0123456789" },
  });
  expect(created.status).toBe(201);
  const models = (await (await api("/models")).json()) as {
    models: { id: string; provider: string; available: boolean; recommended: boolean }[];
    providers: { id: string; label: string; hasKey: boolean }[];
  };
  expect(models.providers.map((p) => p.id).slice(0, 3)).toEqual(["anthropic", "openai", "gemini"]);
  expect(models.providers.find((p) => p.id === "gemini")).toMatchObject({ label: "Gemini", hasKey: true });
  expect(models.models.filter((m) => m.provider === "gemini")).toMatchObject([
    { id: "gemini-4-carbon", available: true, recommended: false },
    { id: "gemini-4-hydrogen", available: true, recommended: false },
    { id: "gemini-4-argon", available: true, recommended: false },
    { id: "gemini-3.8-flash", available: true, recommended: true },
    { id: "gemini-3.5-flash-lite", available: true, recommended: false },
  ]);
});

test("an OpenRouter key: checked before it is stored, then its models listed, the good picks first", async () => {
  let reads = 0;
  enableOpenRouterModels((async () => {
    reads++;
    return new Response(JSON.stringify(fixture));
  }) as unknown as typeof fetch);
  /** OpenRouter's `GET /api/v1/key`, answered by the next status here (no network). */
  const answers: (number | "management")[] = [401, "management", 200, 502];
  t = await createTestServer({
    http: (async () => {
      const next = answers.shift();
      return next === "management"
        ? new Response(JSON.stringify({ data: { is_management_key: true } }))
        : new Response(JSON.stringify({ data: { is_management_key: false } }), { status: next });
    }) as unknown as typeof fetch,
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  type Listed = { id: string; provider: string; available?: boolean; pick?: boolean; inputUsdPerMTok: number };
  const listed = async (path: string) =>
    ((await (await owner(path)).json()) as { models: Listed[] }).models.filter((m) => m.provider === "openrouter");

  // No workspace has an OpenRouter key yet: OpenRouter isn't asked for its list.
  expect(await listed("/api/app/models")).toEqual([]);
  expect(reads).toBe(0);

  const add = (apiKey: string) =>
    api("/credentials", { json: { provider: "openrouter", label: "OpenRouter", apiKey } });
  const refused = await add("or-test-refused-1234");
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("provider_key_invalid");
  const manager = await add("or-test-manager-1234");
  expect(((await manager.json()) as { error: { code: string } }).error.code).toBe("provider_key_management");
  expect((await add("or-test-good-1234")).status).toBe(201);
  // OpenRouter didn't answer either way: kept.
  expect((await add("or-test-later-5678")).status).toBe(201);

  const all = await listed("/api/app/models");
  expect(reads).toBe(1);
  expect(all.slice(0, 4).map((m) => [m.id, m.pick])).toEqual([
    ["~z-ai/glm-latest", true],
    ["~deepseek/deepseek-flash-latest", true],
    ["~openai/gpt-luna-latest", true],
    ["~anthropic/claude-sonnet-latest", true],
  ]);
  expect(all.find((m) => m.id === "tencent/hy3-preview")).toMatchObject({ pick: false, inputUsdPerMTok: 0.18 });
  const mine = await listed(`/api/app/organizations/${orgId}/models`);
  expect(mine.every((m) => m.available)).toBe(true);
  expect(mine.map((m) => m.id)).toEqual(all.map((m) => m.id));

  // Automático's tiers on the OpenRouter key: OpenRouter's models only; null puts one back on its default.
  const tiers = async (autoModels: unknown) => api("/settings", { method: "PATCH", json: { autoModels } });
  expect((await tiers({ openrouter: { large: "claude-opus-5-5" } })).status).toBe(400);
  expect((await tiers({ openrouter: { huge: "z-ai/glm-5.3" } })).status).toBe(400);
  const saved = await tiers({ openrouter: { large: "anthropic/claude-sonnet-5.5", small: "z-ai/glm-5.3" } });
  expect(((await saved.json()) as { autoModels: unknown }).autoModels).toEqual({
    openrouter: { large: "anthropic/claude-sonnet-5.5", small: "z-ai/glm-5.3" },
  });
  await tiers({ openrouter: { small: null } });
  expect(((await (await api("/settings")).json()) as { autoModels: unknown }).autoModels).toEqual({
    openrouter: { large: "anthropic/claude-sonnet-5.5" },
  });
  // About 2.5 s alone (a server, a sign-up's password hash, a dozen requests); past bun's 5 s default under a full run.
}, 20_000);

test("a key with no credit isn't stored, and the answer carries the provider's name and words", async () => {
  t = await createTestServer({
    reply: () =>
      new ProviderError("no prepaid credit left at the provider (429 insufficient_quota): Add credit.", false, 429),
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const before = ((await (await api("/credentials")).json()) as { credentials: unknown[] }).credentials.length;
  const refused = await api("/credentials", {
    json: { provider: "openai", label: "OpenAI", apiKey: "sk-proj-abcdefgh" },
  });
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: object }).error).toMatchObject({
    code: "provider_key_no_credit",
    params: { provider: "OpenAI", said: "Add credit." },
  });
  const after = ((await (await api("/credentials")).json()) as { credentials: unknown[] }).credentials.length;
  expect(after).toBe(before);
});

test("a key saved says it passed; it can be tried again; with `release` it goes though it's the default", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = await api("/credentials", {
    json: { provider: "openai", label: "OpenAI", apiKey: "sk-proj-abcdefgh", makeDefault: true },
  });
  const key = (await created.json()) as { id: string; check: string };
  expect(key.check).toBe("ok");
  const again = await api(`/credentials/${key.id}/check`, { json: {} });
  expect((await again.json()) as object).toEqual({ check: "ok" });
  const refused = await api(`/credentials/${key.id}?purge=true`, { method: "DELETE" });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("credential.default");
  expect((await api(`/credentials/${key.id}?purge=true&release=true`, { method: "DELETE" })).status).toBe(204);
});

test("past a person's hourly key tests a key saves unchecked: no one sorts stolen keys through this server", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = await api("/credentials", {
    json: { provider: "openai", label: "OpenAI", apiKey: "sk-proj-abcdefgh" },
  });
  const key = (await created.json()) as { id: string; check: string };
  expect(key.check).toBe("ok");
  const checks: string[] = [];
  for (let i = 0; i < 30; i++) {
    const res = await api(`/credentials/${key.id}/check`, { json: {} });
    checks.push(((await res.json()) as { check: string }).check);
  }
  expect(checks.at(0)).toBe("ok");
  expect(checks.at(-1)).toBe("unchecked");
}, 20_000);
