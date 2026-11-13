import { afterEach, describe, expect, test } from "bun:test";
import {
  ACCOUNTS_PROTOCOL,
  BRAIN_PROTOCOL,
  CODEX_WINDOWS_PROTOCOL,
  CONTEXT_LIMIT_PROTOCOL,
  MISSION_PROTOCOL,
  OPENCODE_ACP_PROTOCOL,
  SPEED_PROTOCOL,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { CODING_PLANS, learnPlanModels, planOf } from "@agenteschat/providers/plans";
import {
  ConflictError,
  canTalkTo,
  ForbiddenError,
  getAgentBrain,
  NO_PERSON,
  newAgentBrainMachines,
  releaseAgents,
  setAgentAudience,
  setAgentBrain,
  takeBackPlan,
  updateAgent,
  ValidationError,
} from "../src";
import {
  brainModelId,
  brainModelLabel,
  brainModelOptions,
  brainOf,
  brainOptions,
  defaultBrainModel,
  executorBrain,
  normalizeBrainModel,
} from "../src/brain-settings";
import { contextFields, recordPlanUsage, speedFields } from "../src/brains/claude-code";
import { brainAccountFor, brainSpeedFor, planIsOwners } from "../src/brains/select";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

const mac = (patch: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "mac",
  protocol: BRAIN_PROTOCOL,
  execAllowed: true,
  executors: { claude: { version: "2.1.0" }, detectedAt: "2026-10-17" },
  online: true,
  lastSeenAt: new Date(),
  deletedAt: null,
  ...patch,
});

describe("brain settings", () => {
  test("a coding plan's models: any of them by id, its aliases named after what they run there", () => {
    expect(brainModelOptions("claude_code").map((o) => o.label)).toEqual(["Fable", "Opus", "Sonnet", "Haiku"]);
    // Fable runs by its full id (whatever Claude Code's `fable` alias means), with its 1M window.
    expect(brainModelOptions("claude_code")[0]).toMatchObject({
      value: "claude-fable-5-2",
      modelId: "claude-fable-5-2",
      contextWindow: 1_000_000,
    });
    expect(normalizeBrainModel("claude_code", "claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(brainModelId("claude_code", "claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(brainModelOptions("codex").every((o) => o.modelId?.startsWith("gpt"))).toBe(true);
    // Codex offers the catalog's OpenAI rows, GPT-6.1 Terra and GPT-6 Astra among them; GPT-6.1 Sol stays its default.
    expect(brainModelOptions("codex").map((o) => o.label)).toEqual([
      "GPT-6 Astra",
      "GPT-6.1 Sol",
      "GPT-6.1 Terra",
      "GPT-6 Sol",
      "GPT-6 Luna",
    ]);
    expect(brainModelOptions("codex")[0]).toMatchObject({
      value: "gpt-6-astra",
      modelId: "gpt-6-astra",
      contextWindow: 1_050_000,
    });
    expect(normalizeBrainModel("codex", "gpt-6-astra")).toBe("gpt-6-astra");
    // An alias the plan leaves out, or "Automático", is its main model; the value stays an alias.
    expect(brainModelLabel("claude_code", "opus", "zai")).toBe("GLM-5.3");
    expect(brainModelLabel("claude_code", "auto", "minimax")).toBe("MiniMax M3.1 Flash");
    expect(brainModelLabel("claude_code", "opus")).toBe("Opus");
    expect(normalizeBrainModel("claude_code", "haiku")).toBe("haiku");
    // One of a plan's other models is stored by its id and named after it there; while Claude thinks it runs Sonnet.
    expect(normalizeBrainModel("claude_code", "deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
    expect(normalizeBrainModel("claude_code", "k3-256k")).toBe("k3-256k");
    expect(brainModelLabel("claude_code", "deepseek-v4.1-flash", "opencode")).toBe("DeepSeek V4.1 Flash");
    expect(brainModelLabel("claude_code", "deepseek-v4.1-flash", "kimi")).toBe("Kimi for Coding");
    expect(brainModelLabel("claude_code", "deepseek-v4.1-flash")).toBe("Sonnet");
    expect(brainModelLabel("claude_code", "auto")).toBe("auto");
  });

  test("stored values read back; executors map to brains", () => {
    expect(brainOf("claude_code")).toBe("claude_code");
    expect(brainOf("robot")).toBe("model");
    expect(brainOf(null)).toBe("model");
    expect(executorBrain("claude")).toBe("claude_code");
    expect(executorBrain("codex")).toBe("codex");
    expect(executorBrain("agent")).toBe("model");
  });

  test("models: Claude Code aliases mapped to today's ids, Codex free text, defaults", () => {
    expect(normalizeBrainModel("claude_code", "Opus")).toBe("opus");
    expect(normalizeBrainModel("claude_code", "claude-sonnet-5-5")).toBe("sonnet");
    expect(normalizeBrainModel("claude_code", null)).toBeNull();
    expect(() => normalizeBrainModel("claude_code", "gpt-6-sol")).toThrow();
    expect(normalizeBrainModel("codex", "gpt-6.1-codex")).toBe("gpt-6.1-codex");
    expect(() => normalizeBrainModel("codex", "rm -rf /")).toThrow();
    expect(() => normalizeBrainModel("model", "opus")).toThrow();
    expect(defaultBrainModel("claude_code")).toBe("sonnet");
    expect(defaultBrainModel("codex")).toBe("gpt-6.1-sol");
    expect(defaultBrainModel("model")).toBeNull();
    expect(brainModelId("claude_code", "opus")).toBe("claude-opus-5-5");
    expect(brainModelId("claude_code", null)).toBe("claude-sonnet-5-5");
    expect(brainModelId("codex", "gpt-6.1-codex")).toBe("gpt-6.1-codex");
  });

  test("options: on Windows, Codex needs a runner that runs its turns there", () => {
    const reasons = (m: ReturnType<typeof mac>) =>
      brainOptions(m)
        .slice(1, 3)
        .map((o) => [o.kind, o.available, o.reason ?? null]);
    const executors = { claude: { version: "2" }, codex: { version: "codex-cli 0.170.0" }, detectedAt: "x" };
    // An older Windows runner refuses every Codex turn: "update the agentes.chat program", not "update Codex".
    expect(reasons(mac({ os: "windows", protocol: CODEX_WINDOWS_PROTOCOL - 1, executors }))).toEqual([
      ["claude_code", true, null],
      ["codex", false, "runner_old"],
    ]);
    expect(reasons(mac({ os: "windows", protocol: CODEX_WINDOWS_PROTOCOL, executors }))).toEqual([
      ["claude_code", true, null],
      ["codex", true, null],
    ]);
    expect(reasons(mac({ os: "darwin", protocol: CODEX_WINDOWS_PROTOCOL - 1, executors }))[1]).toEqual([
      "codex",
      true,
      null,
    ]);
  });

  test("options: on Windows OpenCode needs a runner that speaks ACP; a CLI that doesn't run on the computer's system says so", () => {
    const executors = {
      claude: { version: "2" },
      cursor: { version: "2026.11.01" },
      opencode: { version: "1.19.5" },
      grok: { version: "1.0.80" },
      antigravity: { version: "1.2.3" },
      detectedAt: "x",
    };
    const reasons = (m: ReturnType<typeof mac>) =>
      Object.fromEntries(
        brainOptions(m)
          .slice(3)
          .map((o) => [o.kind, o.reason ?? null]),
      );
    // An older Windows runner refuses every OpenCode turn; Cursor and Grok Build don't run on Windows; the Antigravity
    // CLI only on Linux.
    expect(reasons(mac({ os: "windows", protocol: OPENCODE_ACP_PROTOCOL - 1, executors }))).toEqual({
      cursor: "system",
      opencode: "runner_old",
      grok: "system",
      antigravity: "system",
    });
    expect(reasons(mac({ os: "windows", protocol: OPENCODE_ACP_PROTOCOL, executors })).opencode).toBeNull();
    expect(reasons(mac({ os: "darwin", protocol: OPENCODE_ACP_PROTOCOL - 1, executors }))).toEqual({
      cursor: null,
      opencode: null,
      grok: null,
      antigravity: "system",
    });
    expect(reasons(mac({ os: "linux", protocol: OPENCODE_ACP_PROTOCOL, executors }))).toEqual({
      cursor: null,
      opencode: null,
      grok: null,
      antigravity: null,
    });
  });

  test("options: only what the computer has; why the rest can't be chosen", () => {
    const reasons = (m: ReturnType<typeof mac> | null) =>
      brainOptions(m).map((o) => [o.kind, o.available, o.reason ?? null]);
    expect(reasons(null)).toEqual([
      ["model", true, null],
      ["claude_code", false, "no_computer"],
      ["codex", false, "no_computer"],
      ["cursor", false, "no_computer"],
      ["opencode", false, "no_computer"],
      ["grok", false, "no_computer"],
      ["antigravity", false, "no_computer"],
    ]);
    expect(reasons(mac())).toEqual([
      ["model", true, null],
      ["claude_code", true, null],
      ["codex", false, "not_installed"],
      // Cursor needs runner protocol 36 (`CURSOR_PROTOCOL`).
      ["cursor", false, "runner_old"],
      // OpenCode needs runner protocol 39 (`OPENCODE_PROTOCOL`).
      ["opencode", false, "runner_old"],
      // Grok needs runner protocol 43 (`GROK_PROTOCOL`).
      ["grok", false, "runner_old"],
      // The Antigravity CLI needs runner protocol 44 (`ANTIGRAVITY_PROTOCOL`).
      ["antigravity", false, "runner_old"],
    ]);
    expect(reasons(mac({ execAllowed: false }))[1]).toEqual(["claude_code", false, "exec_off"]);
    expect(reasons(mac({ protocol: MISSION_PROTOCOL - 1 }))[1]).toEqual(["claude_code", false, "runner_old"]);
    // A runner with missions (protocol 5–7) but without `brain.turn`: the engine would refuse every run.
    expect(reasons(mac({ protocol: BRAIN_PROTOCOL - 1 })).slice(1, 3)).toEqual([
      ["claude_code", false, "runner_old"],
      ["codex", false, "runner_old"],
    ]);
    expect(reasons(mac({ protocol: BRAIN_PROTOCOL }))[1]).toEqual(["claude_code", true, null]);
    // Its runner hasn't looked yet: nobody knows what's there, and it says that, never "not installed".
    const looking = reasons(mac({ executors: {} })).slice(1, 3);
    expect(looking).toEqual([
      ["claude_code", true, null],
      ["codex", false, "not_reported"],
    ]);
    const oldCodex = mac({ executors: { codex: { version: "codex-cli 0.100.0" }, detectedAt: "x" } });
    expect(reasons(oldCodex).slice(1, 3)).toEqual([
      ["claude_code", false, "not_installed"],
      ["codex", false, "outdated"],
    ]);
    const both = mac({ executors: { claude: { version: "2" }, codex: { version: "0.170.0" }, detectedAt: "x" } });
    expect(
      brainOptions(both).every((o) => o.available || ["cursor", "opencode", "grok", "antigravity"].includes(o.kind)),
    ).toBe(true);
    // Installed but turned off in the app's Tools: says so (not "not installed"); turned on, available.
    const off = mac({ ...both, access: { tools: { claude: false, codex: true } } });
    expect(reasons(off).slice(1, 3)).toEqual([
      ["claude_code", false, "tool_off"],
      ["codex", true, null],
    ]);
    expect(reasons(mac({ access: { tools: { claude: true } } }))[1]).toEqual(["claude_code", true, null]);
    // Commands off (the app's default for a new workspace) with Claude Code on: the plan still thinks there, as the
    // runner runs it; "no permission to run programs" is only for a runner that reports no tools.
    const commandsOff = mac({
      ...both,
      execAllowed: false,
      access: { tools: { claude: true, codex: true, commands: false } },
    });
    expect(reasons(commandsOff).slice(1, 3)).toEqual([
      ["claude_code", true, null],
      ["codex", true, null],
    ]);
  });
});

/*
 * ADR 0059 §2–3 and §5: a plan thinks only for its owner's agents, one
 * account per agent, and an agent on a plan answers only its owner until the
 * owner turns on "Atende outras pessoas".
 */
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193dddd-0000-4000-8000-0000000000a1";
const BIAS = "0193dddd-0000-4000-8000-0000000000b1";

/** Ana's computer, with Claude Code on it, and her agent Dev there on the API; Bia a member, Caio an admin. */
async function world() {
  const fx = await setup();
  f = fx;
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  const machineId = paired.machineId;
  await fx.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
    .where(eq(schema.machines.id, machineId));
  await fx.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, fx.agent.id));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const account = (id: string, createdBy: string) =>
    fx.db
      .insert(schema.machineAccounts)
      .values({ id, orgId: fx.org.id, machineId, kind: "claude_code", label: id, status: "active", createdBy });
  const row = async (id = fx.agent.id) => {
    const [r] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, id));
    if (!r) throw new Error("no agent");
    return r;
  };
  const audits = (action: string) => fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  /** Dan edits every agent ("Editar qualquer agente") but may not use other people's plans. */
  const editor = async () => {
    const dan = await addMember(fx.db, fx.org.id, "member", "dan");
    const [role] = await fx.db
      .insert(schema.orgRoles)
      .values({ orgId: fx.org.id, name: "Editores", permissions: ["manage_agents"] })
      .returning();
    if (!role) throw new Error("no role");
    await fx.db.insert(schema.organizationMemberRoles).values({ orgId: fx.org.id, userId: dan.id, roleId: role.id });
    return dan;
  };
  return { fx, deps: { db: fx.db }, machineId, bia, caio, account, row, audits, editor };
}

describe("Criar agente: what a new agent could think with", () => {
  test("admins see every computer with what it offers; a member can't create agents", async () => {
    const { fx, deps, machineId, bia, caio } = await world();
    const [mine] = await newAgentBrainMachines(deps, caio.id, fx.org.id);
    expect(mine).toMatchObject({ machineId, name: "mac" });
    expect(mine?.options.find((o) => o.kind === "claude_code")?.available).toBe(true);
    expect(mine?.options.find((o) => o.kind === "codex")).toMatchObject({ available: false, reason: "not_installed" });
    await expect(newAgentBrainMachines(deps, bia.id, fx.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("context window (Configuração avançada)", () => {
  test("any brain keeps a limit from CONTEXT_LIMITS through a switch; anything else is refused; audited", async () => {
    const { fx, deps, row, audits } = await world();
    const onApi = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { contextTokens: 400_000 });
    expect(onApi).toMatchObject({ brain: "model", contextTokens: 400_000 });
    expect(await row()).toMatchObject({ contextTokens: 400_000 });
    expect((await audits("agent.brain")).at(-1)?.details).toMatchObject({
      from: { contextTokens: null },
      to: { contextTokens: 400_000 },
    });
    // It is the agent's, not the brain's: a switch keeps it, and so does a change that leaves it out.
    const onPlan = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(onPlan).toMatchObject({ brain: "claude_code", contextTokens: 400_000 });
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { model: "opus" })).contextTokens).toBe(
      400_000,
    );
    for (const bad of [300_000, "400000", -1, 2_000_000]) {
      await expect(
        setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { contextTokens: bad }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    // Null: the model's own window again.
    expect(
      (await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { contextTokens: null })).contextTokens,
    ).toBe(null);
    expect(await row()).toMatchObject({ contextTokens: null });
  });

  test("a computer turn carries it only to a runner that knows it (protocol 28)", () => {
    expect(contextFields(CONTEXT_LIMIT_PROTOCOL, { contextTokens: 400_000 })).toEqual({ contextTokens: 400_000 });
    expect(contextFields(CONTEXT_LIMIT_PROTOCOL - 1, { contextTokens: 400_000 })).toEqual({});
    expect(contextFields(CONTEXT_LIMIT_PROTOCOL, {})).toEqual({});
  });

  test("each model choice says its window: which limits are worth offering with it", () => {
    expect(brainModelOptions("claude_code").find((o) => o.value === "opus")?.contextWindow).toBe(1_000_000);
    // A coding plan's models are listed from its catalog by the apps, which read the window off the id (`[1m]`).
    expect(planOf("minimax")?.claudeCode.models.every((m) => m.id.endsWith("[1m]"))).toBe(true);
  });
});

describe("Velocidade (ADR 0149)", () => {
  const fastAgent = { brain: "codex", brainSpeed: "fast", builtin: null };
  const onPlan = { kind: "codex" as const, model: "gpt-6.1-sol" };
  const conversation = { background: false, workId: null };

  test("a conversation's turn of an agent set to it, with a model and sign-in that have it", () => {
    expect(brainSpeedFor(fastAgent, onPlan, conversation, false)).toBe("fast");
    expect(brainSpeedFor(fastAgent, { kind: "codex" }, conversation, false)).toBe("fast");
    expect(brainSpeedFor({ ...fastAgent, brainSpeed: "standard" }, onPlan, conversation, false)).toBeUndefined();
  });

  test("never a routine, long work or a mission: nobody is waiting", () => {
    expect(brainSpeedFor(fastAgent, onPlan, conversation, true)).toBeUndefined();
    expect(brainSpeedFor(fastAgent, onPlan, { ...conversation, background: true }, false)).toBeUndefined();
    expect(brainSpeedFor(fastAgent, onPlan, { ...conversation, workId: "work" }, false)).toBeUndefined();
    expect(brainSpeedFor(fastAgent, { ...onPlan, missionId: "mission" }, conversation, false)).toBeUndefined();
  });

  test("never where it doesn't apply: another model, sign-in or brain, a mission's other brain, the right hand", () => {
    expect(brainSpeedFor(fastAgent, { kind: "codex", model: "gpt-5.5" }, conversation, false)).toBeUndefined();
    const keyAccount = { id: "a", label: "Key", status: "active" as const, provider: "zai" };
    expect(brainSpeedFor(fastAgent, { ...onPlan, account: keyAccount }, conversation, false)).toBeUndefined();
    const onClaude = { ...fastAgent, brain: "claude_code" };
    expect(brainSpeedFor(onClaude, { kind: "claude_code", model: "opus" }, conversation, false)).toBeUndefined();
    expect(brainSpeedFor(onClaude, onPlan, conversation, false)).toBeUndefined();
    expect(brainSpeedFor({ ...fastAgent, builtin: "right_hand" }, onPlan, conversation, false)).toBeUndefined();
  });

  test("it travels only to a runner that knows it (protocol 46)", () => {
    expect(speedFields(SPEED_PROTOCOL, { speed: "fast" })).toEqual({ speed: "fast" });
    expect(speedFields(SPEED_PROTOCOL - 1, { speed: "fast" })).toEqual({});
    expect(speedFields(SPEED_PROTOCOL, {})).toEqual({});
  });

  test("saved with the same permission as the effort, audited, kept through a switch; anything else is refused", async () => {
    const { fx, deps, bia, row, audits } = await world();
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(await row()).toMatchObject({ brainSpeed: "standard" });
    const saved = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { speed: "fast" });
    expect(saved.speed).toBe("fast");
    expect((await audits("agent.brain")).at(-1)?.details).toMatchObject({
      from: { speed: "standard" },
      to: { speed: "fast" },
    });
    await expect(setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { speed: "standard" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { effort: "low" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { speed: "turbo" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // A move to what doesn't take it leaves the choice there for when it comes back.
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "model" })).speed).toBe("fast");
    expect(await row()).toMatchObject({ brain: "model", brainSpeed: "fast" });
  });
});

describe("a plan answers its owner until it answers other people (Atende outras pessoas)", () => {
  test("onto a plan it answers only its owner; turning it on asks nothing and is audited as who may talk to it", async () => {
    const { fx, deps, bia, caio, row, audits } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [bia.id] });
    const onPlan = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(onPlan).toMatchObject({ brain: "claude_code", onlyOwner: true, canUsePlans: true, ownSignIn: true });
    // The people it answered wait for it to be let out again.
    expect(await row()).toMatchObject({ audienceMode: "owner", audienceUserIds: [bia.id] });
    const changes = async () => (await audits("agent.audience_changed")).map((a) => a.details);
    expect((await changes()).at(-1)).toEqual({
      from: { mode: "people", userIds: [bia.id], roleIds: [], consultable: true },
      to: { mode: "owner", userIds: [], roleIds: [], consultable: true },
      planOwner: fx.owner.id,
    });

    // On, it replies to whoever its "who can talk" list lets in: Bia, not the whole workspace.
    const brainAudits = (await audits("agent.brain")).length;
    const shared = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    expect(shared.onlyOwner).toBe(false);
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
    expect((await changes()).at(-1)).toEqual({
      from: { mode: "owner", userIds: [bia.id], roleIds: [], consultable: true },
      to: { mode: "people", userIds: [bia.id], roleIds: [], consultable: true },
      planOwner: fx.owner.id,
    });
    // Nothing about what it thinks with changed: no brain entry for it.
    expect(await audits("agent.brain")).toHaveLength(brainAudits);
    // Other changes keep it on, and off brings back only its owner.
    expect(await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { model: "opus" })).toMatchObject({
      onlyOwner: false,
    });
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: true })).onlyOwner).toBe(true);
    expect(await row()).toMatchObject({ audienceMode: "owner", audienceUserIds: [bia.id] });
    expect((await changes()).at(-1)).toEqual({
      from: { mode: "people", userIds: [bia.id], roleIds: [], consultable: true },
      to: { mode: "owner", userIds: [], roleIds: [], consultable: true },
      planOwner: fx.owner.id,
    });
    // Off and on again never widens it: still Bia alone.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    const again = await row();
    expect(again).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
    expect([canTalkTo(again, bia.id, NO_PERSON), canTalkTo(again, caio.id, NO_PERSON)]).toEqual([true, false]);
  });

  test("moved onto a plan with it on, an agent keeps its list as it was: nothing widens, nothing to record", async () => {
    const { fx, deps, bia, caio, row, audits } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [bia.id] });
    const changes = (await audits("agent.audience_changed")).length;
    const moved = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      onlyOwner: false,
    });
    expect(moved).toMatchObject({ brain: "claude_code", onlyOwner: false });
    const after = await row();
    expect(after).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
    expect([canTalkTo(after, bia.id, NO_PERSON), canTalkTo(after, caio.id, NO_PERSON)]).toEqual([true, false]);
    expect(await audits("agent.audience_changed")).toHaveLength(changes);
  });

  test("restricted with nobody picked yet stays restricted when it answers other people: never everyone", async () => {
    const { fx, deps, bia, row } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [] });
    // Moved onto a plan with "Atende outras pessoas" on (a sign-in for a new agent): its owner alone, as before.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code", onlyOwner: false });
    const moved = await row();
    expect(moved).toMatchObject({ audienceMode: "people", audienceUserIds: [] });
    expect([canTalkTo(moved, fx.owner.id, NO_PERSON), canTalkTo(moved, bia.id, NO_PERSON)]).toEqual([true, false]);
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [] });
  });

  test("restricted with nobody picked yet keeps its mode through the move onto a plan, and after", async () => {
    const { fx, deps, row } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [] });
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [] });
    // A remembered "only me" changes nothing: it already answers its owner alone.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: true });
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [] });
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [] });
  });

  test("its owner or an admin lets more people in and keeps them out, on a plan too; a member can't touch it", async () => {
    const { fx, deps, bia, caio, row } = await world();
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect(await getAgentBrain(deps, caio.id, fx.org.id, fx.agent.id)).toMatchObject({
      onlyOwner: true,
      canUsePlans: false,
    });
    const member = await setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { onlyOwner: false }).catch((e) => e);
    expect(member).toBeInstanceOf(ForbiddenError);
    // With no "who can talk" list, on means everyone.
    expect((await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { onlyOwner: false })).onlyOwner).toBe(false);
    expect(await row()).toMatchObject({ audienceMode: "everyone", audienceUserIds: [] });
    expect((await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { onlyOwner: true })).onlyOwner).toBe(true);
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: false })).onlyOwner).toBe(
      false,
    );
  });

  test("from one plan to another kind of plan it keeps answering whoever its owner let in", async () => {
    const { fx, deps, machineId, bia, caio, row, audits } = await world();
    await fx.db
      .update(schema.machines)
      .set({
        executors: {
          claude: { version: "2.1.304", loggedIn: true },
          codex: { version: "0.170.0" },
          detectedAt: new Date().toISOString(),
        },
      })
      .where(eq(schema.machines.id, machineId));
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [bia.id] });
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code", onlyOwner: false });
    const changes = (await audits("agent.audience_changed")).length;
    // Another model on the same plan, then another plan: neither is a move onto a plan.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code", model: "opus" });
    const moved = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "codex" });
    expect(moved).toMatchObject({ brain: "codex", onlyOwner: false });
    const after = await row();
    expect(after).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
    expect([canTalkTo(after, bia.id, NO_PERSON), canTalkTo(after, caio.id, NO_PERSON)]).toEqual([true, false]);
    expect(await audits("agent.audience_changed")).toHaveLength(changes);
    // One that answered only its owner still does on the other plan.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { onlyOwner: true });
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" })).onlyOwner).toBe(
      true,
    );
  });

  test("back on the API it still answers only its owner; letting it out brings back whoever it answered", async () => {
    const { fx, deps, bia, caio, row } = await world();
    await setAgentAudience(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { mode: "people", userIds: [bia.id] });
    await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "claude_code" });
    expect((await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { brain: "model" })).onlyOwner).toBe(true);
    // No plan any more: an admin may let them in.
    await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { onlyOwner: false });
    expect(await row()).toMatchObject({ audienceMode: "people", audienceUserIds: [bia.id] });
  });
});

describe("a plan thinks only for its owner's agents, one account each", () => {
  test("the agent's owner's accounts only, picked by its owner or an admin; another agent's with moveAccount, unless for all", async () => {
    const { fx, deps, machineId, bia, caio, account, row, audits, editor } = await world();
    await account(ANAS, fx.owner.id);
    await account(BIAS, bia.id);
    const [theo] = await fx.db
      .insert(schema.agents)
      .values({
        orgId: fx.org.id,
        name: "Theo",
        handle: "theo",
        model: "claude-sonnet-5-5",
        ownerUserId: fx.owner.id,
        machineId,
        brain: "claude_code",
        brainAccountId: ANAS,
      })
      .returning();
    if (!theo) throw new Error("no agent");
    // Bia keeps hers to herself ("Só eu", ADR 0059 §3): Dev's page lists Ana's account, never Bia's.
    await fx.db.update(schema.machineAccounts).set({ serves: "owner" }).where(eq(schema.machineAccounts.id, BIAS));
    const dan = await editor();
    const seen = await getAgentBrain(deps, dan.id, fx.org.id, fx.agent.id);
    expect(seen.accounts.map((a) => a.id)).toEqual([ANAS]);
    expect(seen.canUseOthersPlans).toBe(true);
    // Bia's plan thinks only for Bia's agents: nobody gives it to Dev.
    const theirs = await setAgentBrain(deps, dan.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: BIAS,
    }).catch((e) => e);
    expect(theirs).toBeInstanceOf(ForbiddenError);
    expect(theirs.code).toBe("account.not_owner");
    // The plan's paid extra usage bills its owner: an admin never turns it off or on.
    const extra = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { extraUsage: false }).catch((e) => e);
    expect(extra.code).toBe("brain.extra_owner_only");
    const taken = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: ANAS,
    }).catch((e) => e);
    expect(taken).toBeInstanceOf(ConflictError);
    expect(taken).toMatchObject({ code: "account.in_use", params: { agent: "Theo", agentId: theo.id } });

    // An admin picks among Ana's own, as she would.
    const moved = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: ANAS,
      moveAccount: true,
    });
    expect(moved.account).toBe(ANAS);
    // Theo goes back to the computer's own sign-in, Ana's like Theo.
    expect(await row(theo.id)).toMatchObject({ brainAccountId: null, brain: "claude_code" });
    expect((await audits("account.moved"))[0]?.details).toEqual({ from: theo.id, to: fx.agent.id });
    // Theo can't take it back without moving it: a login made for one agent thinks for one.
    const back = await setAgentBrain(deps, fx.owner.id, fx.org.id, theo.id, { account: ANAS }).catch((e) => e);
    expect(back).toMatchObject({ code: "account.in_use", params: { agentId: fx.agent.id } });

    // One the runner made for all of Ana's agents there thinks for both, with no move.
    await fx.db.update(schema.machineAccounts).set({ shared: true }).where(eq(schema.machineAccounts.id, ANAS));
    const both = await setAgentBrain(deps, fx.owner.id, fx.org.id, theo.id, { account: ANAS });
    expect(both.accounts.find((a) => a.id === ANAS)?.usedBy.sort()).toEqual(["Dev", "Theo"]);
    expect(await row(fx.agent.id)).toMatchObject({ brainAccountId: ANAS });
    expect(await audits("account.moved")).toHaveLength(1);
  });

  test("the computer's own sign-in: only for its pairer's agents; an account that goes sends the others to the API", async () => {
    const { fx, deps, bia, caio, account, row } = await world();
    await account(BIAS, bia.id);
    await fx.db
      .update(schema.agents)
      .set({ ownerUserId: bia.id, brain: "claude_code", brainAccountId: BIAS })
      .where(eq(schema.agents.id, fx.agent.id));
    expect(await getAgentBrain(deps, bia.id, fx.org.id, fx.agent.id)).toMatchObject({
      canUsePlans: true,
      ownSignIn: false,
      canManageAccounts: false,
    });
    const own = await setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { account: null }).catch((e) => e);
    expect(own).toBeInstanceOf(ForbiddenError);
    expect(own.code).toBe("account.not_owner");
    const admin = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { account: null }).catch((e) => e);
    expect(admin.code).toBe("account.not_owner");
    // Her account goes: the computer's own sign-in is Ana's, so Bia's agent goes back to the API.
    expect(await releaseAgents(fx.db, fx.org.id, [BIAS])).toEqual([fx.agent.id]);
    expect(await row()).toMatchObject({ brain: "model", brainAccountId: null });
  });

  test("a new owner who doesn't own the plan sends the agent to the API (audited); one who does answers alone", async () => {
    const { fx, bia, account, row, audits } = await world();
    await account(ANAS, fx.owner.id);
    await fx.db
      .update(schema.agents)
      .set({ brain: "claude_code", brainAccountId: ANAS })
      .where(eq(schema.agents.id, fx.agent.id));
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ownerUserId: bia.id });
    expect(await row()).toMatchObject({ ownerUserId: bia.id, brain: "model", brainAccountId: null });
    expect((await audits("agent.brain")).at(-1)?.details).toMatchObject({
      to: { brain: "model", account: null },
      reason: "owner_changed",
    });
    // On the computer's own sign-in (Ana's), shared by someone else: Ana takes it over and answers alone.
    await fx.db
      .update(schema.agents)
      .set({ brain: "claude_code", audienceMode: "everyone" })
      .where(eq(schema.agents.id, fx.agent.id));
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ownerUserId: fx.owner.id });
    expect(await row()).toMatchObject({ brain: "claude_code", audienceMode: "owner" });
    // Restricted with nobody picked already answers its owner alone: the handover keeps it restricted.
    await fx.db
      .update(schema.agents)
      .set({ ownerUserId: bia.id, audienceMode: "people", audienceUserIds: [] })
      .where(eq(schema.agents.id, fx.agent.id));
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { ownerUserId: fx.owner.id });
    expect(await row()).toMatchObject({ brain: "claude_code", audienceMode: "people", audienceUserIds: [] });
  });
});

describe("Usar planos de outras pessoas (ADR 0059 §3, amended 2026-11-04)", () => {
  test("an admin gives Dev Bia's plan: billed to Bia, and she takes it back in one click", async () => {
    const { fx, deps, machineId, bia, caio, account, row, audits } = await world();
    await account(ANAS, fx.owner.id);
    await account(BIAS, bia.id);
    // Admins hold it by default (and owners always): every plan on Dev's computer, each with its owner.
    const seen = await getAgentBrain(deps, caio.id, fx.org.id, fx.agent.id);
    expect(seen.canUseOthersPlans).toBe(true);
    expect(seen.accounts.map((a) => [a.id, a.ownerId, a.email])).toEqual([
      [ANAS, fx.owner.id, null],
      [BIAS, bia.id, null],
    ]);

    const lent = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { brain: "claude_code", account: BIAS });
    expect(lent).toMatchObject({ brain: "claude_code", account: BIAS, onlyOwner: true, extraUsage: false });
    expect(await row()).toMatchObject({ brainAccountId: BIAS, brainAccountLentBy: caio.id });
    expect((await audits("account.lent"))[0]).toMatchObject({
      targetId: BIAS,
      details: { agentId: fx.agent.id, owner: bia.id },
    });
    // The plan stays Bia's: her usage, her limits. Its turns think with her account, and only she pays extra usage.
    const agent = await row();
    expect(await planIsOwners(fx.db, agent, machineId, { id: BIAS })).toBe(true);
    // Kept to Bia ("Só eu"), it thinks for nobody else's agent.
    await fx.db.update(schema.machineAccounts).set({ serves: "owner" }).where(eq(schema.machineAccounts.id, BIAS));
    expect(await planIsOwners(fx.db, agent, machineId, { id: BIAS })).toBe(false);
    await fx.db.update(schema.machineAccounts).set({ serves: "everyone" }).where(eq(schema.machineAccounts.id, BIAS));
    expect((await brainAccountFor(fx.db, agent, "claude_code", machineId))?.id).toBe(BIAS);
    const usage = await recordPlanUsage(fx.db, {
      orgId: fx.org.id,
      agentId: fx.agent.id,
      provider: "claude_code",
      machineId,
      accountId: BIAS,
      inputTokens: 10,
      outputTokens: 5,
    });
    const [record] = await fx.db
      .select()
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.id, usage ?? ""));
    expect(record).toMatchObject({ brainAccountId: BIAS, billedTo: "plan", costNanoUsd: 0 });
    const extra = await setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, { extraUsage: true }).catch((e) => e);
    expect(extra.code).toBe("brain.extra_owner_only");

    // Her plan serves the whole workspace, as she chose: nobody is told, no note and no email.
    expect(await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent.plan_lent"))).toEqual([]);

    // Only Bia takes it back; Dev goes back to the computer's own sign-in, which is its owner's.
    expect((await takeBackPlan(deps, caio.id, fx.org.id, BIAS).catch((e) => e)).code).toBe("account.not_owner");
    expect(await takeBackPlan(deps, bia.id, fx.org.id, BIAS, fx.agent.id)).toEqual({ agentIds: [fx.agent.id] });
    expect(await row()).toMatchObject({ brainAccountId: null, brainAccountLentBy: null, brain: "claude_code" });
    expect((await audits("account.taken_back"))[0]).toMatchObject({
      actorId: bia.id,
      details: { agentId: fx.agent.id, lentBy: caio.id },
    });
  });

  test("a plan given keeps none of the old switches, and leaves with its own", async () => {
    const { fx, deps, bia, caio, account, row } = await world();
    await account(BIAS, bia.id);
    // Dev's paid extra usage was on (its owner's own sign-in): it is never sent on with Bia's plan by someone else.
    expect((await row()).brainExtraUsage).toBe(true);
    const carried = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, {
      brain: "claude_code",
      account: BIAS,
      extraUsage: true,
    }).catch((e) => e);
    expect(carried.code).toBe("brain.extra_owner_only");
    await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { brain: "claude_code", account: BIAS });
    // On her plan Bia turned extra usage on and someone let everyone talk to Dev.
    await fx.db
      .update(schema.agents)
      .set({ brainExtraUsage: true, audienceMode: "everyone" })
      .where(eq(schema.agents.id, fx.agent.id));
    await takeBackPlan(deps, bia.id, fx.org.id, BIAS, fx.agent.id);
    // Back on its owner's own sign-in, which neither pays extra nor answers others until its owner says so.
    expect(await row()).toMatchObject({ brain: "claude_code", brainExtraUsage: false, audienceMode: "owner" });
  });

  test("a login another agent has stays there; taking back from all leaves Bia's own agents alone", async () => {
    const { fx, deps, machineId, bia, caio, account, row } = await world();
    await account(BIAS, bia.id);
    const agentOf = async (name: string, ownerUserId: string) => {
      const [a] = await fx.db
        .insert(schema.agents)
        .values({
          orgId: fx.org.id,
          name,
          handle: name.toLowerCase(),
          model: "claude-sonnet-5-5",
          ownerUserId,
          machineId,
        })
        .returning();
      if (!a) throw new Error("no agent");
      return a;
    };
    const bea = await agentOf("Bea", bia.id);
    const theo = await agentOf("Theo", fx.owner.id);
    await setAgentBrain(deps, bia.id, fx.org.id, bea.id, { brain: "claude_code", account: BIAS });
    // Bia's own agent has her login: nobody else takes it, moving or not.
    for (const move of [false, true]) {
      const taken = await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, {
        brain: "claude_code",
        account: BIAS,
        moveAccount: move,
      }).catch((e) => e);
      expect(taken.code).toBe("account.in_use");
    }
    // Made for all of her agents there, it thinks for the ones others give it too.
    await fx.db.update(schema.machineAccounts).set({ shared: true }).where(eq(schema.machineAccounts.id, BIAS));
    await setAgentBrain(deps, caio.id, fx.org.id, fx.agent.id, { brain: "claude_code", account: BIAS });
    await setAgentBrain(deps, fx.owner.id, fx.org.id, theo.id, { brain: "claude_code", account: BIAS });
    expect((await row(theo.id)).brainAccountLentBy).toBe(fx.owner.id);
    const back = await takeBackPlan(deps, bia.id, fx.org.id, BIAS);
    expect(back.agentIds.sort()).toEqual([fx.agent.id, theo.id].sort());
    expect(await row(bea.id)).toMatchObject({ brainAccountId: BIAS, brainAccountLentBy: null });
  });

  test("Lodi on a teammate's plan: given by whoever manages it while the plan serves everyone, never one kept to its owner", async () => {
    const { fx, deps, bia, caio, account, editor } = await world();
    await account(BIAS, bia.id);
    const [lodi] = await fx.db
      .insert(schema.agents)
      .values({ orgId: fx.org.id, name: "Lodi", handle: "lodi", model: "claude-sonnet-5-5", builtin: "right_hand" })
      .returning();
    if (!lodi) throw new Error("no agent");
    const dan = await editor();
    await fx.db.update(schema.machineAccounts).set({ serves: "owner" }).where(eq(schema.machineAccounts.id, BIAS));
    const refused = await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, {
      brain: "claude_code",
      account: BIAS,
    }).catch((e) => e);
    expect(refused.code).toBe("account.not_owner");
    await fx.db.update(schema.machineAccounts).set({ serves: "everyone" }).where(eq(schema.machineAccounts.id, BIAS));
    expect(
      await setAgentBrain(deps, dan.id, fx.org.id, lodi.id, { brain: "claude_code", account: BIAS }),
    ).toMatchObject({ account: BIAS });
    await setAgentBrain(deps, dan.id, fx.org.id, lodi.id, { brain: "model" });
    const view = await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { brain: "claude_code", account: BIAS });
    expect(view).toMatchObject({ account: BIAS, onlyOwner: true });
    const [saved] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
    expect(saved).toMatchObject({ brainAccountId: BIAS, brainAccountLentBy: caio.id, planForOthers: false });
    expect(await takeBackPlan(deps, bia.id, fx.org.id, BIAS)).toEqual({ agentIds: [lodi.id] });
  });
});

test("a model its plan's list dropped since: a save that repeats it goes through, a new choice of it doesn't", async () => {
  const { fx, deps } = await world();
  const save = (input: Parameters<typeof setAgentBrain>[4]) =>
    setAgentBrain(deps, fx.owner.id, fx.org.id, fx.agent.id, input);
  await save({ brain: "claude_code", model: "hy3" });
  const table = CODING_PLANS.opencode.claudeCode.models;
  learnPlanModels({ opencode: table.filter((m) => m.id !== "hy3") });
  try {
    expect(await save({ brain: "claude_code", model: "hy3", fallback: false })).toMatchObject({
      model: "hy3",
      fallback: false,
    });
    await save({ model: "opus" });
    await expect(save({ model: "hy3" })).rejects.toBeInstanceOf(ValidationError);
  } finally {
    learnPlanModels({ opencode: table });
  }
});
