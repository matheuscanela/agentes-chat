import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type PlanUsage, type PlanWindowKind, type ServerFrame } from "@agenteschat/adapters";
import { testConfig } from "@agenteschat/config";
import { and, eq, schema } from "@agenteschat/db";
import { applyBootSwitches } from "../src/start";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

interface Brain {
  agentId: string;
  brain: string;
  model: string | null;
  effectiveModel: string | null;
  fallback: boolean;
  computer: { machineId: string; name: string; online: boolean } | null;
  options: { kind: string; available: boolean; reason?: string; models: { value: string }[] }[];
  machines: { machineId: string; name: string; online: boolean; options: { kind: string; available: boolean }[] }[];
  canEdit: boolean;
}

interface MissionBrain {
  brain: string | null;
  model: string | null;
  effectiveBrain: string;
  effectiveModel: string | null;
  canSetBrain: boolean;
  canSetModel: boolean;
}

/** A connected runner that starts every task it is asked to. */
function fakeRunner() {
  const hub = t.engine.machineHub;
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "task.start") {
          return ok({
            taskId: frame.taskId,
            pid: 7,
            startedAt: new Date().toISOString(),
            cwd: frame.cwd ?? "",
            command: "claude -p",
          });
        }
        if (frame.op === "read") return ok({ base64: null, size: 0 });
        return ok({ size: 0 });
      }, 1);
    },
    close() {},
  });
  return {
    hello: (token: string) => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true })),
  };
}

async function workspace(env: Record<string, string> = {}) {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true", ...env }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const member = browser(t);
  await signUp(member, "bia@example.com");
  const { url } = (await (
    await api("/invitations", { json: { email: "bia@example.com", role: "member" } })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const asBia = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { ...seeded, api, asBia, owner, member };
}

function pairMac(api: (path: string, init?: Parameters<ReturnType<typeof browser>>[1]) => Promise<Response>) {
  return pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
}

test("agent brain: defaults, who may, letting others talk to a plan, what the computer has, model and fallback", async () => {
  const { api, asBia, agentId } = await workspace();

  // Defaults: the model (API), fallback on, nothing to offer without a computer.
  const first = await api(`/agents/${agentId}/brain`);
  expect(first.status).toBe(200);
  const fresh = (await first.json()) as Brain;
  expect(fresh).toMatchObject({ brain: "model", model: null, effectiveModel: null, fallback: true, computer: null });
  // Accounts (ADR 0041): none without a computer.
  expect(fresh).toMatchObject({
    account: null,
    effort: null,
    accounts: [],
    canManageAccounts: false,
    accountsSupported: false,
    onlyOwner: false,
    canUsePlans: true,
    ownSignIn: false,
  });
  expect(fresh.options.map((o) => [o.kind, o.available, o.reason ?? null])).toEqual([
    ["model", true, null],
    ["claude_code", false, "no_computer"],
    ["codex", false, "no_computer"],
    ["cursor", false, "no_computer"],
    ["opencode", false, "no_computer"],
    ["grok", false, "no_computer"],
    ["antigravity", false, "no_computer"],
  ]);
  expect(fresh.options.find((o) => o.kind === "claude_code")?.models.map((m) => m.value)).toEqual([
    "claude-fable-5-2",
    "opus",
    "sonnet",
    "haiku",
  ]);
  const noComputer = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "claude_code" } });
  expect(noComputer.status).toBe(409);
  expect(((await noComputer.json()) as { error: { code: string } }).error.code).toBe("brain.no_computer");

  // A member neither sees nor changes it.
  expect((await asBia(`/agents/${agentId}/brain`)).status).toBe(403);
  expect((await asBia(`/agents/${agentId}/brain`, { method: "PUT", json: { fallback: false } })).status).toBe(403);

  // With a computer: Claude Code (a runner that doesn't list its CLIs is assumed to have it), no Codex.
  const mac = await pairMac(api);
  // Before it is chosen, the page already knows what each computer offers (the agent moves to one that has it).
  const before = (await (await api(`/agents/${agentId}/brain`)).json()) as Brain;
  expect(before.computer).toBeNull();
  expect(before.machines.map((m) => m.name)).toEqual(["mac"]);
  expect(before.machines[0]?.options.find((o) => o.kind === "claude_code")?.available).toBe(true);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  const withMac = (await (await api(`/agents/${agentId}/brain`)).json()) as Brain;
  expect(withMac.computer?.name).toBe("mac");
  expect(withMac.options.find((o) => o.kind === "claude_code")?.available).toBe(true);
  expect(withMac.options.find((o) => o.kind === "codex")).toMatchObject({ available: false, reason: "not_reported" });

  // Choosing a plan asks nothing: it answers only its owner until they let others in.
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "codex" } })).status).toBe(409);
  const chosen = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "claude_code", model: "Opus" },
  });
  expect(chosen.status).toBe(200);
  expect(await chosen.json()).toMatchObject({
    brain: "claude_code",
    model: "opus",
    effectiveModel: "opus",
    onlyOwner: true,
    ownSignIn: true,
  });
  // "Atende outras pessoas": on with nothing to accept, and Bia may talk to it.
  const canTalk = async () =>
    ((await (await asBia("/agents")).json()) as { agents: { id: string; canTalk: boolean }[] }).agents.find(
      (a) => a.id === agentId,
    )?.canTalk;
  expect(await canTalk()).toBe(false);
  const shared = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { onlyOwner: false } });
  expect(shared.status).toBe(200);
  expect(await shared.json()).toMatchObject({ onlyOwner: false });
  expect(await canTalk()).toBe(true);
  // "Quem pode falar" goes through the same rule: narrowing and widening ask nothing.
  const audience = (mode: string, extra = {}) =>
    api(`/agents/${agentId}`, { method: "PATCH", json: { audience: { mode, userIds: [] }, ...extra } });
  expect((await audience("owner")).status).toBe(200);
  expect(((await (await audience("everyone")).json()) as { audienceMode: string }).audienceMode).toBe("everyone");
  // An older app still sends the terms it used to accept: taken, and changes nothing.
  const older = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { onlyOwner: true, acceptPlanTerms: true },
  });
  expect(await older.json()).toMatchObject({ onlyOwner: true });
  const olderPatch = await audience("everyone", { acceptPlanTerms: true });
  expect(olderPatch.status).toBe(200);
  expect(((await olderPatch.json()) as { audienceMode: string }).audienceMode).toBe("everyone");
  // Each change of who may talk to it is audited as such, never as an acceptance.
  const changes = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.audience_changed"));
  expect(changes.map((a) => (a.details as { to: { mode: string } }).to.mode)).toEqual([
    "owner",
    "everyone",
    "owner",
    "everyone",
    "owner",
    "everyone",
  ]);

  // Model and fallback change without confirming again; bad models are refused.
  const fallbackOff = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { fallback: false } });
  expect(fallbackOff.status).toBe(200);
  expect(await fallbackOff.json()).toMatchObject({ brain: "claude_code", model: "opus", fallback: false });
  const sonnet = (await (
    await api(`/agents/${agentId}/brain`, { method: "PUT", json: { model: null } })
  ).json()) as Brain;
  expect(sonnet).toMatchObject({ model: null, effectiveModel: "sonnet" });
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { model: "gpt-6-sol" } })).status).toBe(400);
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "robot" } })).status).toBe(400);

  // Persisted, and audited.
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(row).toMatchObject({ brain: "claude_code", brainModel: null, brainFallback: false });
  const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.brain"));
  expect(audit.length).toBe(3);
  expect(JSON.stringify(audit.map((a) => a.details))).not.toMatch(/acceptedPlanTerms|audience/);

  // Codex appears once the computer has a recent one; any model name is taken as typed.
  await t.db
    .update(schema.machines)
    .set({
      executors: { claude: { version: "2.1.0" }, codex: { version: "codex-cli 0.170.0" }, detectedAt: "2026-10-17" },
    })
    .where(eq(schema.machines.id, mac.machineId));
  const codex = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "codex", model: "gpt-6.1-codex" },
  });
  expect(codex.status).toBe(200);
  expect(await codex.json()).toMatchObject({ brain: "codex", model: "gpt-6.1-codex" });

  // Back to the API: no confirmation, the model is cleared.
  const back = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "model" } });
  expect(await back.json()).toMatchObject({ brain: "model", model: null, fallback: false });
});

test("Outros agentes podem consultar: the audience carries the switch, on by default, kept when absent", async () => {
  const { api, agentId } = await workspace();
  const patch = async (audience: Record<string, unknown>) =>
    (
      (await (await api(`/agents/${agentId}`, { method: "PATCH", json: { audience } })).json()) as {
        audience: { consultable?: boolean };
      }
    ).audience.consultable;
  expect(await patch({ mode: "owner", userIds: [], consultable: false })).toBe(false);
  expect(await patch({ mode: "owner", userIds: [] })).toBe(false);
  expect(await patch({ mode: "owner", userIds: [], consultable: true })).toBe(true);
});

test("Quem pode falar by role: whoever holds it talks to the agent, from the moment they get it until they lose it", async () => {
  const { api, asBia, member, agentId } = await workspace();
  const biaId = ((await (await member("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const role = (await (await api("/roles", { json: { name: "Suporte" } })).json()) as { id: string };
  const canTalk = async () =>
    ((await (await asBia("/agents")).json()) as { agents: { id: string; canTalk: boolean }[] }).agents.find(
      (a) => a.id === agentId,
    )?.canTalk;
  const patched = await api(`/agents/${agentId}`, {
    method: "PATCH",
    json: { audience: { mode: "people", userIds: [], roleIds: [role.id] } },
  });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { audience: unknown }).audience).toEqual({
    mode: "people",
    userIds: [],
    roleIds: [role.id],
    consultable: true,
  });
  expect(await canTalk()).toBe(false);
  await api(`/members/${biaId}/roles`, { method: "PUT", json: { roleIds: [role.id] } });
  expect(await canTalk()).toBe(true);
  await api(`/members/${biaId}/roles`, { method: "PUT", json: { roleIds: [] } });
  expect(await canTalk()).toBe(false);
  // Not a role id: refused before it reaches the database.
  const bad = await api(`/agents/${agentId}`, {
    method: "PATCH",
    json: { audience: { mode: "people", userIds: [], roleIds: ["suporte"] } },
  });
  expect(bad.status).toBe(400);
});

test("where the server provisions the computers (the Cloud), an agent on a plan replies to everyone once its owner says so", async () => {
  const cloud = { MACHINE_PROVISIONING: "external", OPERATOR_API_TOKEN: "o".repeat(40) };
  // Booted as the Cloud's server boots: the switches `startServer` sets from this config.
  applyBootSwitches(testConfig(cloud));
  try {
    const { api, asBia, agentId } = await workspace(cloud);
    // On its owner's plan, as a switch onto one leaves it: only its owner talks to it.
    await t.db
      .update(schema.agents)
      .set({ brain: "claude_code", audienceMode: "owner" })
      .where(eq(schema.agents.id, agentId));
    const dm = async () => (await asBia("/dms", { json: { agentId } })).status;
    expect(await dm()).toBe(403);
    const on = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { onlyOwner: false } });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ brain: "claude_code", onlyOwner: false });
    expect(await dm()).toBe(200);
  } finally {
    applyBootSwitches(testConfig());
  }
});

test("the agent list says who thinks: the brain, its model's label, the computer only for admins and the owner", async () => {
  const { api, asBia, agentId } = await workspace();
  type Listed = {
    id: string;
    model: string;
    brain?: { kind: string; model: string | null; computer?: string; account?: string };
  };
  const listed = async (as: typeof api) =>
    ((await (await as("/agents")).json()) as { agents: Listed[] }).agents.find((a) => a.id === agentId);
  expect((await listed(api))?.brain).toEqual({ kind: "model", model: null });

  const mac = await pairMac(api);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "claude_code" } });
  // Its owner connected the computer, so the computer's own sign-in thinks for it (named by its plan, not known yet).
  expect((await listed(api))?.brain).toEqual({
    kind: "claude_code",
    model: "Sonnet 5.5",
    computer: "mac",
    account: "Claude",
  });
  // A member: the brain and its model, not the computer.
  expect((await listed(asBia))?.brain).toEqual({ kind: "claude_code", model: "Sonnet 5.5", account: "Claude" });
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { model: "opus" } });
  expect((await listed(api))?.brain?.model).toBe("Opus 5.5");
  // An edit answers with it too.
  const edited = (await (
    await api(`/agents/${agentId}`, { method: "PATCH", json: { role: "Marketing" } })
  ).json()) as Listed;
  expect(edited.brain).toEqual({ kind: "claude_code", model: "Opus 5.5", computer: "mac", account: "Claude" });
});

test("the agent list carries a plan agent's account and its last windows, for everyone (ADR 0063 §5)", async () => {
  const { api, asBia, agentId, orgId } = await workspace();
  type Listed = { id: string; brain?: { account?: string; usage?: PlanUsage } };
  const brainOf = async (as: typeof api) =>
    ((await (await as("/agents")).json()) as { agents: Listed[] }).agents.find((a) => a.id === agentId)?.brain;
  const usage = (kind: PlanWindowKind, usedPercent: number): PlanUsage => ({
    windows: [{ kind, usedPercent, resetsAt: "2099-01-01T14:00:00.000Z" }],
    source: "probe",
    at: "2026-10-30T12:00:00.000Z",
  });
  const mac = await pairMac(api);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  await api(`/agents/${agentId}/brain`, { method: "PUT", json: { brain: "claude_code" } });

  // The computer's own sign-in: its plan and windows as the runner said them.
  const week = usage("seven_day", 40);
  await t.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.0", plan: "max" }, ownUsage: { claude_code: week } } })
    .where(eq(schema.machines.id, mac.machineId));
  expect(await brainOf(api)).toMatchObject({ account: "Claude Max", usage: week });
  expect(await brainOf(asBia)).toMatchObject({ account: "Claude Max", usage: week });

  // Its own account: that account's name and windows; before any window is known, the name alone.
  const [owner] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "owner@example.com"));
  const accountId = crypto.randomUUID();
  await t.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId,
    machineId: mac.machineId,
    kind: "claude_code",
    label: "Claude Team 2",
    plan: "team",
    createdBy: owner?.id ?? null,
  });
  await t.db.update(schema.agents).set({ brainAccountId: accountId }).where(eq(schema.agents.id, agentId));
  const unknown = await brainOf(asBia);
  expect(unknown?.account).toBe("Claude Team 2");
  expect(unknown && "usage" in unknown).toBe(false);
  const hours = usage("five_hour", 12);
  await t.db.update(schema.machineAccounts).set({ usage: hours }).where(eq(schema.machineAccounts.id, accountId));
  expect(await brainOf(asBia)).toMatchObject({ account: "Claude Team 2", usage: hours });

  // Someone else's agent on that computer: its own sign-in isn't theirs, so no plan and nothing to show.
  const [bia] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "bia@example.com"));
  await t.db
    .update(schema.agents)
    .set({ brainAccountId: null, ownerUserId: bia?.id ?? null })
    .where(eq(schema.agents.id, agentId));
  const theirs = await brainOf(asBia);
  expect(theirs && ("account" in theirs || "usage" in theirs)).toBe(false);
});

test("a new agent starts on Automático on every brain; one with a fixed model keeps the brain's default", async () => {
  // The deployment's AGENT_DEFAULT_MODEL doesn't decide it any more.
  const { api, owner, agentId: fixedId } = await workspace({ AGENT_DEFAULT_MODEL: "claude-haiku-5-5" });
  expect(await (await owner("/api/app/models")).json()).toMatchObject({ defaultModel: "auto", planModels: {} });
  const created = await api("/agents", { json: { name: "Eva", handle: "eva" } });
  expect(created.status).toBe(201);
  const eva = (await created.json()) as { id: string; model: string };
  expect(eva.model).toBe("auto");
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, eva.id));
  expect(row).toMatchObject({ model: "auto", brain: "model", brainModel: "auto", brainEffort: "auto" });

  // A computer with Claude Code and Codex, for both agents.
  const mac = await pairMac(api);
  await t.db
    .update(schema.machines)
    .set({
      executors: { claude: { version: "2.1.0" }, codex: { version: "codex-cli 0.170.0" }, detectedAt: "2026-10-17" },
    })
    .where(eq(schema.machines.id, mac.machineId));
  for (const id of [eva.id, fixedId]) {
    await api(`/agents/${id}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  }
  const brain = (id: string, json: Record<string, unknown>) => api(`/agents/${id}/brain`, { method: "PUT", json });

  // Claude Code without a model chosen: Automático, model and effort; it stays through another switch.
  const claude = await brain(eva.id, { brain: "claude_code" });
  expect(await claude.json()).toMatchObject({
    brain: "claude_code",
    model: "auto",
    effectiveModel: "auto",
    effort: "auto",
  });
  const codex = await brain(eva.id, { brain: "codex" });
  expect(await codex.json()).toMatchObject({ brain: "codex", model: "auto", effort: "auto" });
  // A fixed model belongs to its brain: back on the API and over to Claude Code, it's that brain's default again.
  expect((await brain(eva.id, { model: "gpt-6-sol" })).status).toBe(200);
  await brain(eva.id, { brain: "model" });
  const again = await brain(eva.id, { brain: "claude_code" });
  expect(await again.json()).toMatchObject({ model: null, effectiveModel: "sonnet" });

  // An agent on a fixed model (chosen, or made before Automático): Claude Code starts on its default, as before.
  const fixed = await brain(fixedId, { brain: "claude_code" });
  expect(await fixed.json()).toMatchObject({
    brain: "claude_code",
    model: null,
    effectiveModel: "sonnet",
    effort: null,
  });
});

test("one agent's setup on others (ADR 0094): a preview keeps nothing, each agent by its rules, new agents start with it", async () => {
  const { api, asBia, agentId, credentialId } = await workspace();
  const eva = (await (await api("/agents", { json: { name: "Eva", handle: "eva" } })).json()) as { id: string };
  const mac = await pairMac(api);
  for (const id of [agentId, eva.id]) {
    await api(`/agents/${id}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  }
  const setup = { brain: "claude_code", machineId: mac.machineId, account: null, model: "opus", effort: "high" };
  const use = (json: Record<string, unknown>, as = api) => as("/agent-setup", { json });
  type Results = { results: { agentId: string; status: string; reason?: string }[] };
  const brainOf = async (id: string) => (await (await api(`/agents/${id}/brain`)).json()) as Brain;
  const newAgentSetup = async () => ((await (await api("/agent-setup")).json()) as { setup: unknown }).setup;
  // Dev was created on Sonnet with the workspace's key, Eva on Automático: Dev's is the last pick.
  const created = {
    brain: "model",
    model: "claude-sonnet-5-5",
    key: credentialId,
    contextTokens: null,
    autonomy: null,
  };
  expect(await newAgentSetup()).toEqual(created);

  const preview = await use({ setup, agentIds: [agentId, eva.id], preview: true });
  expect(preview.status).toBe(200);
  expect(((await preview.json()) as Results).results.map((r) => r.status)).toEqual(["applied", "applied"]);
  expect((await brainOf(eva.id)).brain).toBe("model");
  expect(await newAgentSetup()).toEqual(created);

  const done = (await (await use({ setup, agentIds: [agentId, eva.id] })).json()) as Results;
  expect(done.results.map((r) => r.status)).toEqual(["applied", "applied"]);
  expect(await brainOf(eva.id)).toMatchObject({ brain: "claude_code", model: "opus", effort: "high" });
  expect(await newAgentSetup()).toMatchObject({
    brain: "claude_code",
    model: "opus",
    computer: { machineId: mac.machineId, name: "mac" },
    account: null,
    ownSignIn: true,
    effort: "high",
  });

  // A member changes only their own agents; creating agents (Todos' by default), she reads what new ones start with.
  const bia = (await (await use({ setup, agentIds: [eva.id] }, asBia)).json()) as Results;
  expect(bia.results).toEqual([{ agentId: eva.id, status: "skipped", reason: "not_allowed" }]);
  expect((await asBia("/agent-setup")).status).toBe(200);
  expect((await use({ setup, agentIds: [] })).status).toBe(400);
  expect((await use({ setup: { ...setup, effort: "hard" }, agentIds: [eva.id] })).status).toBe(400);
});

test("the Autonomia goes with the setup (ADR 0094); a new agent starts with one only from an admin or its owner", async () => {
  const { api, asBia, member, agentId } = await workspace();
  const autonomyOf = async (id: string) =>
    ((await (await api(`/agents/${id}/brain`)).json()) as { autonomy: string }).autonomy;
  const created = await api("/agents", {
    json: { name: "Eva", handle: "eva", model: "claude-opus-5-5", autonomy: "always" },
  });
  const eva = (await created.json()) as { id: string };
  expect(await autonomyOf(eva.id)).toBe("always");

  // Dev takes the model and the Autonomia; Eva already thinks so and takes the Autonomia alone.
  const setup = { brain: "model", model: "claude-opus-5-5", autonomy: "never" };
  const use = (json: Record<string, unknown>) => api("/agent-setup", { json });
  const expected = [
    { agentId, status: "applied", autonomy: { from: "low_risk_auto", to: "never" } },
    { agentId: eva.id, status: "same", autonomy: { from: "always", to: "never" } },
  ];
  const preview = await use({ setup, agentIds: [agentId, eva.id], preview: true });
  expect(((await preview.json()) as { results: unknown[] }).results).toEqual(expected);
  expect(await autonomyOf(eva.id)).toBe("always");
  const done = await use({ setup, agentIds: [agentId, eva.id] });
  expect(((await done.json()) as { results: unknown[] }).results).toEqual(expected);
  expect([await autonomyOf(agentId), await autonomyOf(eva.id)]).toEqual(["never", "never"]);
  const last = (await (await api("/agent-setup")).json()) as { setup: { autonomy: string | null } };
  expect(last.setup.autonomy).toBe("never");
  expect((await use({ setup: { ...setup, autonomy: "sometimes" }, agentIds: [eva.id] })).status).toBe(400);

  // Bia creates agents: only her own (ADR 0085 §5), so she sets its Autonomia; nobody's is refused, Autonomia or not.
  const role = await api("/roles", { json: { name: "Criadores", permissions: ["create_agents"] } });
  const biaId = ((await (await member("/api/app/me")).json()) as { user: { id: string } }).user.id;
  await api(`/members/${biaId}/roles`, {
    method: "PUT",
    json: { roleIds: [((await role.json()) as { id: string }).id] },
  });
  const make = (handle: string, ownerUserId: string | null) =>
    asBia("/agents", { json: { name: handle, handle, ownerUserId, autonomy: "never" } });
  expect((await make("ivo", biaId)).status).toBe(201);
  expect((await make("rui", null)).status).toBe(403);
  expect((await asBia("/agents", { json: { name: "Lua", handle: "lua", ownerUserId: null } })).status).toBe(403);
  const lua = await asBia("/agents", { json: { name: "Lua", handle: "lua", autonomy: "never" } });
  expect(lua.status).toBe(201);
  expect(await autonomyOf(((await lua.json()) as { id: string }).id)).toBe("never");
});

test("mission brain: from the executor by default; the brain before Start, the model any time; who may", async () => {
  const { api, asBia, agentId, channelId } = await workspace();
  const mac = await pairMac(api);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  await fakeRunner().hello(mac.token);
  const mission = (await (
    await api("/missions", { json: { agentId, channelId, goal: "Build our mobile app", title: "Mobile app" } })
  ).json()) as { id: string; executor: string };
  expect(mission.executor).toBe("claude");

  const read = await api(`/missions/${mission.id}/brain`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    brain: null,
    model: null,
    effectiveBrain: "claude_code",
    effectiveModel: "sonnet",
    canSetBrain: true,
    canSetModel: true,
  });

  // The agent's own Claude Code model carries over to its missions.
  await t.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "haiku" })
    .where(eq(schema.agents.id, agentId));
  expect(((await (await api(`/missions/${mission.id}/brain`)).json()) as MissionBrain).effectiveModel).toBe("haiku");

  const opus = await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "opus" } });
  expect(opus.status).toBe(200);
  expect(await opus.json()).toMatchObject({ model: "opus", effectiveModel: "opus" });
  expect((await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "o p u s" } })).status).toBe(400);
  expect((await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { brain: "codex" } })).status).toBe(409);

  // A member who isn't taking part can read it, not change it.
  const bia = await asBia(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "haiku" } });
  expect([403, 404]).toContain(bia.status);

  // Started: the brain is locked, the model still changes.
  await t.db.update(schema.missions).set({ status: "active" }).where(eq(schema.missions.id, mission.id));
  const locked = await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { brain: "model" } });
  expect(locked.status).toBe(409);
  expect(((await locked.json()) as { error: { code: string } }).error.code).toBe("mission.wrong_status");
  const active = (await (await api(`/missions/${mission.id}/brain`)).json()) as MissionBrain;
  expect(active).toMatchObject({ canSetBrain: false, canSetModel: true });
  const sonnet = await api(`/missions/${mission.id}/brain`, { method: "PUT", json: { model: "sonnet" } });
  expect(await sonnet.json()).toMatchObject({ model: "sonnet", effectiveBrain: "claude_code" });

  const [row] = await t.db.select().from(schema.missions).where(eq(schema.missions.id, mission.id));
  expect(row).toMatchObject({ brain: null, brainModel: "sonnet" });
  const events = await t.db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, mission.id));
  expect(events.filter((e) => e.kind === "brain_changed").length).toBe(2);
});

test("a new agent's canTalk reads the creator's roles: a role it answers that the creator holds lets them in", async () => {
  const { api, owner, member } = await workspace();
  const me = async (who: typeof owner) =>
    ((await (await who("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const [ownerId, biaId] = [await me(owner), await me(member)];
  const roleId = async (name: string) =>
    ((await (await api("/roles", { json: { name } })).json()) as { id: string }).id;
  const [board, support] = [await roleId("Diretoria"), await roleId("Suporte")];
  const held = (await (await api("/members")).json()) as { members: { userId: string; roleIds: string[] }[] };
  const mine = held.members.find((m) => m.userId === ownerId)?.roleIds ?? [];
  expect((await api(`/members/${ownerId}/roles`, { method: "PUT", json: { roleIds: [...mine, board] } })).status).toBe(
    200,
  );
  const create = async (handle: string, roleIds: string[]) =>
    (await (
      await api("/agents", {
        json: { name: handle, handle, ownerUserId: biaId, audience: { mode: "people", userIds: [], roleIds } },
      })
    ).json()) as { canTalk: boolean };
  expect((await create("eva", [board])).canTalk).toBe(true);
  expect((await create("ivo", [support])).canTalk).toBe(false);
});

test("someone else's plan (ADR 0059 §3): the workspace's owner gives Bia's to an agent, and only Bia takes it back", async () => {
  const { api, asBia, agentId, orgId } = await workspace();
  const mac = await pairMac(api);
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  const [bia] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "bia@example.com"));
  const accountId = crypto.randomUUID();
  await t.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId,
    machineId: mac.machineId,
    kind: "claude_code",
    label: "Claude",
    status: "active",
    createdBy: bia?.id ?? null,
  });
  // The workspace's owner may use other people's plans: Bia's shows on the agent's page, with whose it is.
  const seen = (await (await api(`/agents/${agentId}/brain`)).json()) as Brain & {
    canUseOthersPlans: boolean;
    accounts: { id: string; ownerId: string; email: string | null }[];
  };
  expect(seen.canUseOthersPlans).toBe(true);
  expect(seen.accounts).toEqual([expect.objectContaining({ id: accountId, ownerId: bia?.id, email: null })]);
  const put = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "claude_code", account: accountId },
  });
  expect(put.status).toBe(200);
  expect(((await put.json()) as { account: string }).account).toBe(accountId);

  // Taking it back is the plan's owner's alone, not even the workspace's owner's.
  const stranger = await api(`/ai-accounts/${accountId}/take-back`, { json: {} });
  expect(stranger.status).toBe(403);
  const back = await asBia(`/ai-accounts/${accountId}/take-back`, { json: { agentId } });
  expect(back.status).toBe(200);
  expect(await back.json()).toEqual({ agentIds: [agentId] });
  const [row] = await t.db
    .select({ account: schema.agents.brainAccountId, lentBy: schema.agents.brainAccountLentBy })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId));
  expect(row).toEqual({ account: null, lentBy: null });
  // Who it serves is Bia's alone to choose: "Só eu" keeps it to her own agents.
  const serves = (as: typeof api, to: string) =>
    as(`/ai-accounts/${accountId}/serves`, { method: "PUT", json: { serves: to } });
  expect((await serves(api, "owner")).status).toBe(403);
  const only = await serves(asBia, "owner");
  expect(only.status).toBe(200);
  expect(await only.json()).toEqual({ serves: "owner", agentIds: [] });
  const refused = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "claude_code", account: accountId },
  });
  expect(refused.status).toBe(403);
});

test("the team's right hand: `mine` is every member's own by default, `workspace` stays the admins'", async () => {
  const { api, asBia, orgId } = await workspace();
  const [lodi] = await t.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, "right_hand")));
  const id = lodi?.id;
  const mine = await asBia(`/agents/${id}/brain`);
  expect(mine.status).toBe(200);
  expect(await mine.json()).toMatchObject({ scope: "mine", brain: "model", canUsePlans: true });
  expect((await asBia(`/agents/${id}/brain?scope=workspace`)).status).toBe(403);
  const workspaceAi = await api(`/agents/${id}/brain?scope=workspace`);
  expect(workspaceAi.status).toBe(200);
  expect(await workspaceAi.json()).toMatchObject({ scope: "workspace" });
});
