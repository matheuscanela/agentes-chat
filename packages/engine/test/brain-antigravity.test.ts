import { expect, test } from "bun:test";
import { ANTIGRAVITY_PROTOCOL, LOCKED_BRAIN_PROTOCOL } from "@agenteschat/adapters";
import { ANTIGRAVITY_MODELS, GEMINI_ENTERPRISE_PROVIDER, signInProviderOf } from "@agenteschat/providers/plans";
import { antigravityModels, brainOptions, defaultBrainModel, isBrainKind } from "../src/brain-settings";
import { AntigravityBrain, type BrainTurnRequest, type ComputerBrainLink } from "../src/brains/codex";
import { computerBrainUnavailable, NO_AI_CODES, UNAVAILABLE_CODES } from "../src/brains/select";
import { BRAIN_NAMES, BRAIN_PLAN_NAMES, type BrainEvent, type BrainTurn, isComputerBrain } from "../src/brains/types";
import { defaultAccountLabel, sharesSignIns } from "../src/machine-accounts";
import type { MachineStatus } from "../src/machine-hub";
import { scrubSignIns } from "../src/tool-detail";

const SESSION = "0193aaaa-0000-7000-8000-00000000f0df";
const ACCOUNT = { id: "0193eeee-0000-7000-8000-000000000002", label: "Gemini", status: "active" as const };

const turn = (over: Partial<BrainTurn> = {}): BrainTurn => ({
  runId: "0193aaaa-0000-7000-8000-000000000002",
  orgId: "org",
  agentId: "agent",
  channelId: "channel",
  threadRootId: null,
  system: "You are Dev.",
  messages: [{ role: "user", content: "run the tests" }],
  tools: [],
  trigger: "run the tests",
  session: { id: SESSION, resume: false, machineId: "m1", cwd: "" },
  account: ACCOUNT,
  ...over,
});

function link(opts: {
  protocol?: number;
  installed?: boolean;
  tools?: { claude: boolean; codex: boolean; antigravity?: boolean; commands: boolean };
  events?: BrainEvent[];
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: true,
        execAllowed: true,
        protocol: opts.protocol ?? ANTIGRAVITY_PROTOCOL,
        executors: opts.installed === false ? {} : { antigravity: { version: "agy 1.4.12" } },
        ...(opts.tools ? { access: { tools: opts.tools } } : {}),
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const brain = (l: ComputerBrainLink, permissions?: BrainTurnRequest["permissions"]) =>
  new AntigravityBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    ...(permissions ? { permissions: async () => permissions } : {}),
  });

test("a Gemini turn goes to the runner as kind antigravity with its account; its usage passes through as the person's plan", async () => {
  const l = link({
    events: [
      { type: "text_delta", text: "All good." },
      { type: "usage", input: 1000, output: 40, source: "plan", model: "gemini-4-argon-high", cacheRead: 400 },
      { type: "done", text: "All good.", session: { id: "c3b6" } },
    ],
  });
  const events = await collect(brain(l).run(turn({ model: "gemini-4-argon-high" }), io()));
  expect(l.sent[0]).toMatchObject({ kind: "antigravity", account: ACCOUNT.id, model: "gemini-4-argon-high" });
  expect(events.at(-1)).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
  expect(events.find((e) => e.type === "usage")).toMatchObject({ source: "plan", cacheRead: 400 });
});

test("Gemini refuses before the runner: an older runner, its CLI missing, its switch off (following Codex's when unset)", async () => {
  const first = async (l: ComputerBrainLink) => (await collect(brain(l).run(turn(), io())))[0];
  expect(await first(link({ protocol: ANTIGRAVITY_PROTOCOL - 1 }))).toMatchObject({ code: "runner_outdated" });
  expect(await first(link({ installed: false }))).toMatchObject({ code: "antigravity_missing" });
  expect(await first(link({ tools: { claude: true, codex: false, commands: true } }))).toMatchObject({
    code: "tool_off",
  });
  expect(await first(link({ tools: { claude: true, codex: true, antigravity: false, commands: true } }))).toMatchObject(
    { code: "tool_off" },
  );
  expect(ANTIGRAVITY_PROTOCOL).toBeGreaterThan(LOCKED_BRAIN_PROTOCOL);
  const l = link({ events: [{ type: "done", text: "ok" }] });
  await collect(brain(l, { mode: "chat" }).run(turn(), io()));
  expect(l.sent[0]?.permissions).toEqual({ mode: "chat" });
  expect(UNAVAILABLE_CODES.has("antigravity_missing") && NO_AI_CODES.has("antigravity_missing")).toBe(true);
});

test("Quem pensa: Gemini where its runner and CLI are, its models as the CLI listed them (else the known ones), each with its catalog model", () => {
  const machine = (over: Record<string, unknown> = {}) =>
    ({
      id: "m1",
      name: "box",
      execAllowed: true,
      protocol: ANTIGRAVITY_PROTOCOL,
      online: true,
      lastSeenAt: new Date(),
      executors: {
        antigravity: { version: "agy 1.4.12", models: [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }] },
      },
      ...over,
    }) as never;
  const option = (m: unknown) => brainOptions(m as never).find((o) => o.kind === "antigravity");
  expect(option(machine())).toMatchObject({
    available: true,
    defaultModel: null,
    models: [{ value: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", modelId: "gemini-4-argon" }],
  });
  expect(option(machine({ protocol: ANTIGRAVITY_PROTOCOL - 1 }))).toMatchObject({ reason: "runner_old" });
  expect(option(machine({ executors: { detectedAt: "x" } }))).toMatchObject({ reason: "not_installed" });
  expect(option(machine({ executors: {} }))).toMatchObject({ reason: "not_reported" });
  expect(antigravityModels([]).map((m) => m.value)).toEqual(ANTIGRAVITY_MODELS.map((m) => m.id));
  // Hydrogen and Carbon (Ultra's), at any level, xhigh included, are their catalog models.
  expect(
    antigravityModels([
      { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)" },
      { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" },
    ]).map((m) => m.modelId),
  ).toEqual(["gemini-4-hydrogen", "gemini-4-carbon"]);
  expect(antigravityModels([]).find((m) => m.value === "gemini-4-hydrogen-low")?.modelId).toBe("gemini-4-hydrogen");
  expect(defaultBrainModel("antigravity")).toBeNull();
  expect(isBrainKind("antigravity") && isComputerBrain("antigravity")).toBe(true);
  expect([BRAIN_NAMES.antigravity, BRAIN_PLAN_NAMES.antigravity, defaultAccountLabel("antigravity")]).toEqual([
    "Antigravity CLI",
    "Gemini",
    "Gemini",
  ]);
});

test("a Gemini sign-in is per agent, never made for all agents where each is its own OS user; Enterprise signs in again as Enterprise", () => {
  const system = { protocol: ANTIGRAVITY_PROTOCOL, executors: { mode: "system" as const } };
  expect(sharesSignIns(system as never, "antigravity")).toBe(false);
  expect(signInProviderOf(GEMINI_ENTERPRISE_PROVIDER)).toBe("enterprise");
  expect(signInProviderOf("zai")).toBe("zai");
  expect(signInProviderOf(null)).toBeUndefined();
});

test("availability: Gemini's account decides, signed out says so", () => {
  const status = {
    name: "box",
    online: true,
    execAllowed: true,
    protocol: ANTIGRAVITY_PROTOCOL,
    pairedByUserId: "u1",
    executors: { antigravity: { version: "agy 1.4.12" }, detectedAt: new Date().toISOString() },
  } as unknown as MachineStatus;
  expect(computerBrainUnavailable("antigravity", "m1", status, Date.now(), ACCOUNT)).toBeNull();
  expect(
    computerBrainUnavailable("antigravity", "m1", status, Date.now(), { ...ACCOUNT, status: "signed_out" }),
  ).toMatchObject({ code: "not_logged_in" });
});

test("the right hand's reply never carries a Google token, refresh token, key or client secret", () => {
  // Made up, and built here so no scanner reads them as real ones.
  const access = ["ya29", ".", "a0FakeAccessTokenForTestsOnly_x"].join("");
  const refresh = ["1//", "0gFakeRefreshTokenForTestsOnly"].join("");
  const key = ["AIza", "FakeKeyForTestsOnly0123456789abcdef"].join("");
  const secret = ["GOCSPX", "-FakeClientSecretForTests"].join("");
  const out = scrubSignIns(`token ${access} refresh ${refresh} key ${key} secret ${secret}`, "[removed]");
  for (const v of [access, refresh, key, secret]) expect(out.text).not.toContain(v);
  expect(out.found).toBe(4);
});
