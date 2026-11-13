import {
  ACCOUNTS_PROTOCOL,
  type AccountKind,
  ANTIGRAVITY_PROTOCOL,
  BRAIN_PROTOCOL,
  type BrainEffort,
  type BrainSpeed,
  CODEX_WINDOWS_PROTOCOL,
  CURSOR_PROTOCOL,
  GROK_PROTOCOL,
  isBrainEffort,
  isBrainSpeed,
  OPENCODE_ACP_PROTOCOL,
  OPENCODE_PROTOCOL,
  type OwnPlanUsage,
  PLAN_KEYS_PROTOCOL,
  type PlanUsage,
  type PubSub,
} from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  schema,
  sql,
} from "@agenteschat/db";
import {
  AUTO_MODEL,
  type ContextLimit,
  catalogModelOf,
  contextWindowOf,
  isAutoModel,
  isContextLimit,
  MODEL_CATALOG,
  modelProvider,
  parseCustomModel,
} from "@agenteschat/providers";
import {
  ANTIGRAVITY_MODELS,
  antigravityBaseModel,
  claudeCodeModel,
  GROK_BUILD_MODELS,
  isPlanModelId,
  OPENCODE_FREE_MODELS,
  planModel,
  planModelById,
  planOf,
  speedFits,
} from "@agenteschat/providers/plans";
import { type Agent, getAgent, rememberAgentSetup, setupOfAgent } from "./agents";
import {
  type AgentAudience,
  answersOthers,
  audienceChanged,
  audienceOf,
  dropMailIfWidened,
  OWNER_ONLY,
  planOpened,
} from "./audience";
import { recordAudit } from "./audit";
import { BRAIN_NAMES, type BrainKind, brainRunsOn, isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { defaultCredentials, providerKeyOf } from "./credentials";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import {
  defaultAccountLabel,
  forgetAgents,
  getListedAccount,
  isPlanServes,
  LISTED_ACCOUNT_STATUSES,
  listMachineAccounts,
  type MachineAccountView,
  mayAddAccounts,
  type PlanServes,
  publishAccountsChanged,
  releaseAgents,
  sameLogins,
  sharesSignIns,
} from "./machine-accounts";
import { getMachine, type MachineRow, machineOnline, mayBeHome, publishMachineAgentsChanged } from "./machines";
import {
  agentMissionApproval,
  type CommandApproval,
  type MissionDeps,
  type MissionRow,
  machineExecutors,
  OPEN_MISSION_STATUSES,
  publishMissionEvent,
  recordMissionEvent,
  requireAct,
  requireMission,
  requireOpen,
} from "./missions";
import { planLentGroup, planModelDroppedGroup } from "./notification-producers";
import { resolveNotifications } from "./notifications";
import { can, getMembership, requirePermission } from "./organizations";
import { isRightHand, personalBrain } from "./right-hand";
import { orgModelProvider } from "./router";
import { readRefusal } from "./standing";
import { wakeAgentUsageWaits } from "./usage-pause";

/*
 * "Quem pensa" (ADR 0032 §5): the brain an agent thinks with, its model and
 * the fallback to the API, stored on the agent (`agents.brain*`), and a
 * mission's override (`missions.brain*`). This module stores and validates
 * the choice and says what the agent's computer can offer; the engine
 * resolves it per run (`brainFor`).
 */

export const BRAIN_KINDS: readonly BrainKind[] = [
  "model",
  "claude_code",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
];
export const isBrainKind = (v: unknown): v is BrainKind =>
  typeof v === "string" && (BRAIN_KINDS as readonly string[]).includes(v);
/** An effort as stored: a level, or `auto` (the judge picks it per run). */
export type BrainEffortSetting = BrainEffort | typeof AUTO_MODEL;
export const isBrainEffortSetting = (v: unknown): v is BrainEffortSetting =>
  isBrainEffort(v) || isAutoModel(v as string);

/** A stored value read back (anything unknown is the model brain). */
export const brainOf = (v: unknown): BrainKind => (isBrainKind(v) ? v : "model");

export interface BrainModelOption {
  /** What is stored and passed to the CLI (`--model opus`, `-m gpt-…`). */
  value: string;
  label: string;
  /** The model id behind an alias (Claude Code's `opus` → `claude-opus-5-5`). */
  modelId?: string;
  recommended?: boolean;
  /** Its context window in tokens: which context limits are worth offering with it. */
  contextWindow?: number;
  /**
   * Cursor (ADR 0114): its CLI said the person's plan includes it. Other models Cursor bills at API prices; absent
   * when the CLI didn't say.
   */
  inPlan?: boolean;
  /** OpenCode (ADR 0132): a model of OpenCode's free tier (no key, no cost). */
  free?: boolean;
}

/**
 * OpenCode's models: what its CLI listed on the agent's computer (`opencode models`, `provider/model`), else OpenCode's
 * free tier; the free ones first, but a free variant (`opencode/glm-5.3-flash-free`) right after its paid model when
 * that is listed too, as OpenCode's console shows them. With none chosen its CLI's own default runs. Any other
 * `provider/model` is accepted as typed (a key's paid models, which the computer's own CLI may not list).
 */
export const opencodeModels = (listed: readonly { id: string; label?: string; free?: boolean }[] = []) => {
  const all = listed.length ? listed : OPENCODE_FREE_MODELS.map((m) => ({ ...m, free: true }));
  const variantOf = (m: { id: string }) => all.find((f) => f.free && f.id === `${m.id}-free`);
  const paired = new Set(all.map(variantOf));
  return all
    .filter((m) => !paired.has(m))
    .sort((a, b) => Number(b.free === true) - Number(a.free === true))
    .flatMap((m) => [m, variantOf(m)].filter((x) => x !== undefined))
    .map(
      (m): BrainModelOption => ({
        value: m.id,
        label: m.label || m.id.replace(/^opencode\//, ""),
        ...(m.free ? { free: true } : {}),
      }),
    );
};

/**
 * Cursor's models: what its CLI listed on the agent's computer (`agent models`), the plan's own first (its CLI's
 * default runs when none is chosen). Any other name is accepted as typed.
 */
export const cursorModels = (listed: readonly { id: string; label?: string; inPlan?: boolean }[] = []) =>
  [...listed]
    .sort((a, b) => Number(b.inPlan === true) - Number(a.inPlan === true))
    .map(
      (m): BrainModelOption => ({
        value: m.id,
        label: m.label || m.id,
        ...(catalogModelOf(m.id) ? { modelId: m.id } : {}),
        ...(m.inPlan ? { inPlan: true } : {}),
      }),
    );

/** Grok Build's models (ADR 0142): what its CLI listed on the agent's computer (`grok models`), else `GROK_BUILD_MODELS`. */
export const grokModels = (listed: readonly { id: string; label?: string }[] = []): BrainModelOption[] =>
  (listed.length ? listed : GROK_BUILD_MODELS).map((m) => ({
    value: m.id,
    label: m.label || m.id,
    ...(catalogModelOf(m.id) ? { modelId: m.id } : {}),
  }));

/**
 * The Antigravity CLI's models (ADR 0143): what it listed on the agent's computer (`agy models`), else
 * `ANTIGRAVITY_MODELS`. A slug is a model at one thinking level (`gemini-4-argon-high`): its catalog model is the base.
 */
export const antigravityModels = (listed: readonly { id: string; label?: string }[] = []): BrainModelOption[] =>
  (listed.length ? listed : ANTIGRAVITY_MODELS).map((m) => {
    const base = antigravityBaseModel(m.id);
    return { value: m.id, label: m.label || m.id, ...(catalogModelOf(base) ? { modelId: base } : {}) };
  });

/**
 * Claude Code's aliases (`--model opus|sonnet|haiku`), mapped to today's ids in the catalog. Fable goes by its full id,
 * so the turn runs that exact model whatever Claude Code's own `fable` alias points at; "Automático" never picks it.
 */
export const CLAUDE_CODE_MODELS: readonly BrainModelOption[] = [
  { value: "claude-fable-5-2", label: "Fable", modelId: "claude-fable-5-2" },
  { value: "opus", label: "Opus", modelId: "claude-opus-5-5" },
  { value: "sonnet", label: "Sonnet", modelId: "claude-sonnet-5-5", recommended: true },
  { value: "haiku", label: "Haiku", modelId: "claude-haiku-5-5" },
];

/** Codex's models: the OpenAI rows of the catalog (any other name is accepted as typed). */
export const codexModels = (): BrainModelOption[] =>
  Object.entries(MODEL_CATALOG)
    .filter(([, m]) => m.provider === "openai")
    .map(([id, m]) => ({ value: id, label: m.label, modelId: id, ...(m.recommended ? { recommended: true } : {}) }));

/**
 * The model choices of a brain (none for the model brain: it uses the agent's model). A coding plan's are in its
 * catalog (`@agenteschat/providers/plans`), which the apps read.
 */
export function brainModelOptions(
  kind: BrainKind,
  machine?: { executors?: schema.MachineExecutors | null } | null,
): BrainModelOption[] {
  return modelChoices(kind, machine).map((o) =>
    o.modelId ? { ...o, contextWindow: contextWindowOf(catalogModelOf(o.modelId) ?? o.modelId) } : o,
  );
}

function modelChoices(kind: BrainKind, machine?: { executors?: schema.MachineExecutors | null } | null) {
  if (kind === "claude_code") return [...CLAUDE_CODE_MODELS];
  if (kind === "codex") return codexModels();
  if (kind === "cursor") return cursorModels(machine?.executors?.cursor?.models);
  if (kind === "opencode") return opencodeModels(machine?.executors?.opencode?.models);
  if (kind === "grok") return grokModels(machine?.executors?.grok?.models);
  if (kind === "antigravity") return antigravityModels(machine?.executors?.antigravity?.models);
  return [];
}

/** What a computer brain runs with when nobody chose a model (Cursor, OpenCode, Grok, Antigravity: its CLI's own default, null). */
export function defaultBrainModel(kind: BrainKind): string | null {
  if (kind === "model" || kind === "cursor" || kind === "opencode" || kind === "grok" || kind === "antigravity")
    return null;
  const options = brainModelOptions(kind);
  return (options.find((o) => o.recommended) ?? options[0])?.value ?? (kind === "codex" ? "gpt-6.1-sol" : "sonnet");
}

/** The model id behind a stored value (an alias resolved; anything else as is). */
export function brainModelId(kind: BrainKind, model: string | null | undefined): string | undefined {
  const value = model ?? defaultBrainModel(kind);
  if (!value) return undefined;
  return brainModelOptions(kind).find((o) => o.value === value)?.modelId ?? value;
}

const FREE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/**
 * A model for a brain, as stored: null = the brain's default. Claude Code
 * takes its aliases, a full Claude id or a coding plan's model; Codex any
 * model name (a new one may come out before our catalog knows it); the model
 * brain none.
 */
export function normalizeBrainModel(kind: BrainKind, value: unknown, stored?: string | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ValidationError("The model is a name", "brain.invalid_model");
  const v = value.trim();
  if (kind === "model") {
    throw new ValidationError("The API brain uses the agent's model", "brain.invalid_model");
  }
  // The apps send the model with every save, and a plan's list may have dropped it since: repeating it is no new choice.
  if (v === stored) return v;
  // "Automático": each run picks the tier (`auto-model.ts`).
  if (v.toLowerCase() === AUTO_MODEL) return AUTO_MODEL;
  if (kind === "claude_code") {
    const alias = CLAUDE_CODE_MODELS.find((o) => o.value === v.toLowerCase() || o.modelId === v);
    if (alias) return alias.value;
    if (/^claude-[a-z0-9.-]{1,60}$/.test(v) || isPlanModelId(v)) return v;
    throw new ValidationError("Choose Opus, Sonnet, Haiku or one of the plan's models", "brain.invalid_model", {
      brain: kind,
    });
  }
  if (!FREE_MODEL.test(v)) throw new ValidationError("That isn't a model name", "brain.invalid_model", { brain: kind });
  // OpenCode runs `--model provider/model` (its runner refuses anything else).
  if (kind === "opencode" && !/^[\w.-]{1,40}\/[\w.:-]{1,79}$/.test(v)) {
    throw new ValidationError("OpenCode's models are provider/model, like opencode/big-pickle", "brain.invalid_model", {
      brain: kind,
    });
  }
  return v;
}

/** Why a computer brain can't be chosen right now. */
export type BrainUnavailable =
  | "no_computer"
  | "exec_off"
  | "runner_old"
  | "tool_off"
  | "not_installed"
  | "outdated"
  /** Its runner hasn't said which CLIs it has yet (`detectedAt`): nobody knows whether this one is there. */
  | "not_reported"
  /** Its runner doesn't run this CLI on the computer's system (`brainRunsOn`): Cursor on Windows, for one. */
  | "system";

export interface BrainOption {
  kind: BrainKind;
  available: boolean;
  reason?: BrainUnavailable;
  models: BrainModelOption[];
  defaultModel: string | null;
}

type MachineLike = Parameters<typeof machineExecutors>[0] & {
  id: string;
  name: string;
  /** Its system (`hello.os`): a Windows runner before `CODEX_WINDOWS_PROTOCOL` can't think with Codex. */
  os?: string;
  /** Protocol 10: what the machine allows (the app's Ferramentas); absent on older runners. */
  access?: {
    tools?: {
      claude?: boolean;
      codex?: boolean;
      cursor?: boolean;
      opencode?: boolean;
      grok?: boolean;
      antigravity?: boolean;
    };
  } | null;
} & Parameters<typeof machineOnline>[0];

/** A CLI the computer doesn't list: gone only once its runner has looked (the same check the turns make). */
const missingCli = (machine: MachineLike): BrainUnavailable =>
  machine.executors?.detectedAt ? "not_installed" : "not_reported";

/**
 * What the agent's computer can think with; the model brain always. A
 * computer brain needs the runner's `brain.turn` (`BRAIN_PROTOCOL`, the same
 * check the engine makes per run): an older runner is `runner_old`.
 * (Missions' legacy executor tasks keep their own check, `machineExecutors`.)
 */
export function brainOptions(machine: MachineLike | null): BrainOption[] {
  // Only which CLIs are installed: `machineExecutors` lists none with commands off, but commands are judged below.
  const found = machine ? machineExecutors({ ...machine, execAllowed: true }) : null;
  const computer = (kind: "claude_code" | "codex", executor: "claude" | "codex"): BrainOption => {
    let reason: BrainUnavailable | undefined;
    // A runner that reports its tools (protocol 10) runs a coding CLI by that CLI's own switch, commands off or not
    // (`toolOff` in brains/claude-code.ts, `toolOn` on the runner); only an older one follows commands (`exec`).
    if (!machine) reason = "no_computer";
    else if (!machine.access?.tools && !machine.execAllowed) reason = "exec_off";
    else if (machine.protocol < BRAIN_PROTOCOL) reason = "runner_old";
    else if (executor === "codex" && machine.os === "windows" && machine.protocol < CODEX_WINDOWS_PROTOCOL)
      reason = "runner_old";
    else if (machine.access?.tools && machine.access.tools[executor] !== true) reason = "tool_off";
    else if (!found?.available.includes(executor))
      reason = executor === "codex" && found?.codexTooOld ? "outdated" : missingCli(machine);
    return {
      kind,
      available: !reason,
      ...(reason ? { reason } : {}),
      models: brainModelOptions(kind),
      defaultModel: defaultBrainModel(kind),
    };
  };
  return [
    { kind: "model", available: true, models: [], defaultModel: null },
    computer("claude_code", "claude"),
    computer("codex", "codex"),
    cliOption(machine, "cursor"),
    cliOption(machine, "opencode"),
    cliOption(machine, "grok"),
    cliOption(machine, "antigravity"),
  ];
}

/**
 * Cursor (ADR 0114, runner protocol 36) or OpenCode (ADR 0132, protocol 39): the runner's protocol, its switch (or
 * Codex's on a runner before it) and its CLI found there.
 */
function cliOption(machine: MachineLike | null, kind: "cursor" | "opencode" | "grok" | "antigravity"): BrainOption {
  const tools = machine?.access?.tools;
  let reason: BrainUnavailable | undefined;
  if (!machine) reason = "no_computer";
  else if (!tools && !machine.execAllowed) reason = "exec_off";
  else if (
    machine.protocol <
    {
      cursor: CURSOR_PROTOCOL,
      opencode: OPENCODE_PROTOCOL,
      grok: GROK_PROTOCOL,
      antigravity: ANTIGRAVITY_PROTOCOL,
    }[kind]
  )
    reason = "runner_old";
  // On Windows a runner before `OPENCODE_ACP_PROTOCOL` refuses every OpenCode turn.
  else if (kind === "opencode" && machine.os === "windows" && machine.protocol < OPENCODE_ACP_PROTOCOL)
    reason = "runner_old";
  else if (!brainRunsOn(kind, machine.os)) reason = "system";
  else if (tools && (tools[kind] ?? tools.codex) !== true) reason = "tool_off";
  else if (!machine.executors?.[kind]) reason = missingCli(machine);
  return {
    kind,
    available: !reason,
    ...(reason ? { reason } : {}),
    models: brainModelOptions(kind, machine),
    defaultModel: null,
  };
}

/** "Usar um computador": the agent's machine as the brain section shows it. */
export interface BrainComputer {
  machineId: string;
  name: string;
  online: boolean;
}

/** A computer the caller may give the agent, with what it offers (the page moves the agent to one that has a brain). */
export interface BrainMachineOptions extends BrainComputer {
  options: BrainOption[];
}

/**
 * Which AI of the team's right hand (ADR 0137 §11): `mine`, the caller's own, which their DM thinks with; `workspace`,
 * what everyone's DM thinks with while they have none (admins set it). Every other agent has one.
 */
export type BrainScope = "mine" | "workspace";

/** With `mine`: what the caller's DM with the right hand thinks with while they have no AI of their own. */
export interface RightHandWorkspaceAi {
  /** `model`: an API key; else the plan's brain. */
  brain: BrainKind;
  /** The plan's owner; null on a key. */
  ownerId: string | null;
  /** It thinks for the caller: a key, a plan its owner lets serve everyone ("Atende outras pessoas"), or theirs. */
  servesYou: boolean;
  /** On a key: the workspace's key it thinks with, by its provider and name; null with none (the server's may serve). */
  key?: { provider: string; label: string } | null;
}

export interface AgentBrainView {
  agentId: string;
  /** The team's right hand only: which of its AIs this is. */
  scope?: BrainScope;
  /** The team's right hand, `mine` only. */
  workspaceAi?: RightHandWorkspaceAi;
  brain: BrainKind;
  /** As stored (null = the brain's default). */
  model: string | null;
  /** What it runs with (`model ?? defaultModel`), null for the model brain. */
  effectiveModel: string | null;
  fallback: boolean;
  /** Long work may go on into the plan's paid extra usage where the provider reports it on (ADR 0118). */
  extraUsage: boolean;
  computer: BrainComputer | null;
  options: BrainOption[];
  /** Every computer the caller may give the agent (admins: all; its owner: the ones they connected), with its options. */
  machines: BrainMachineOptions[];
  /** The caller may change it (an admin or the agent's owner). */
  canEdit: boolean;
  /** The account its computer brain runs with (ADR 0041); null = the computer's own sign-in. */
  account: string | null;
  /** How hard its computer brain thinks; `auto` = picked per run; null = the CLI's default. */
  effort: BrainEffortSetting | null;
  /** How fast it answers in conversations (ADR 0149): kept whatever it thinks with, applied only where it fits. */
  speed: BrainSpeed;
  /** The most context it reads, in tokens (`CONTEXT_LIMITS`, any brain); null = its model's window. */
  contextTokens: ContextLimit | null;
  /**
   * The accounts on its computer it may think with, both kinds ([] without a computer): its owner's, every one that
   * serves the whole workspace (ADR 0059 §3), and the one it thinks with; emails only of the caller's own.
   */
  accounts: MachineAccountView[];
  /** The caller may add an account there for this agent: its owner, on a computer where they add accounts. */
  canManageAccounts: boolean;
  /** The computer's runner knows accounts (protocol 13). */
  accountsSupported: boolean;
  /** Nobody but its owner talks to it ("Atende outras pessoas" off, ADR 0059 §5). */
  onlyOwner: boolean;
  /**
   * The caller owns the agent, so its plans are the caller's own: they sign one in for it. Admins choose among its
   * owner's accounts and whom it answers too.
   */
  canUsePlans: boolean;
  /**
   * Always true since plans serve the whole workspace (ADR 0059 §3, amended 2026-11-12): `accounts` lists every plan
   * there that serves everyone, whoever connected it, and the caller may give it any of them. Older apps read it.
   */
  canUseOthersPlans: boolean;
  /** The computer's own sign-in can think for it: the person who connected the computer owns the agent. */
  ownSignIn: boolean;
  /** The computer's own sign-ins' plan usage, by brain (protocol 19; empty: not known). */
  ownUsage: OwnPlanUsage;
  /** Its Autonomia (the autonomy its missions start with): "Usar em outros agentes" takes it along (ADR 0094). */
  autonomy: CommandApproval;
  /**
   * The workspace's live API keys, their id and provider only (`GET …/brain`): which providers its owner may move it
   * onto in the model picker, since only admins list the keys themselves.
   */
  keys?: { id: string; provider: string }[];
}

/** The account part of the brain view. */
interface BrainAccounts {
  accounts: MachineAccountView[];
  canManageAccounts: boolean;
  accountsSupported: boolean;
}

const NO_ACCOUNTS: BrainAccounts = { accounts: [], canManageAccounts: false, accountsSupported: false };

/**
 * The accounts on the agent's computer it may think with: its owner's, every one that serves the whole workspace
 * (ADR 0059 §3), and the one it uses; and whether the caller adds one there for it.
 */
async function brainAccounts(
  db: Database,
  userId: string,
  orgId: string,
  agent: Pick<Agent, "ownerUserId" | "brainAccountId" | "builtin">,
  machine: Pick<MachineRow, "id" | "protocol" | "pairedByUserId"> | null,
): Promise<BrainAccounts> {
  if (!machine) return NO_ACCOUNTS;
  const supported = machine.protocol >= ACCOUNTS_PROTOCOL;
  const accounts = await listMachineAccounts({ db }, orgId, machine.id, userId);
  return {
    accounts: accounts.filter(
      (a) =>
        (a.ownerId !== null && a.serves === "everyone") ||
        (agent.ownerUserId !== null && a.ownerId === agent.ownerUserId) ||
        a.id === agent.brainAccountId,
    ),
    canManageAccounts: supported && agent.ownerUserId === userId && mayAddAccounts(machine, userId),
    accountsSupported: supported,
  };
}

interface BrainDeps {
  db: Database;
}

/**
 * Admins (`manage_agents`) and the agent's owner see and change it; anyone else gets a 403. The team's right hand's
 * `mine` (ADR 0137 §11) is every member's own: theirs to see and change.
 */
async function agentBrainAccess(db: Database, userId: string, orgId: string, agentId: string, scope?: unknown) {
  const membership = await requirePermission(db, userId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  const admin = can(membership, "manage_agents");
  const which: BrainScope | undefined = isRightHand(agent) ? (scope === "mine" ? "mine" : "workspace") : undefined;
  if (which !== "mine" && !admin && agent.ownerUserId !== userId) {
    throw new ForbiddenError("Only an admin or the agent's owner can see who thinks for it", "agent.not_owner");
  }
  return { agent, admin, membership, scope: which };
}

/**
 * The team's right hand as its AI settings see it (ADR 0137 §1, amended 2026-11-04): it is on no computer and its owner
 * is the workspace's, so on a plan (`account`, the one asked for else its own) the computer is that account's and the
 * plan is its owner's. With none yet, the computer a plan would sign in on for the caller: the workspace's own, else
 * the first one the caller connected, and the plan would be the caller's. Every other agent is itself.
 */
async function settingsAgent(db: Database, agent: Agent, userId: string, account?: unknown): Promise<Agent> {
  if (!isRightHand(agent)) return agent;
  const id = typeof account === "string" && account ? account : account === undefined ? agent.brainAccountId : null;
  if (id) {
    const [row] = await db
      .select({ machineId: schema.machineAccounts.machineId, ownerId: schema.machineAccounts.createdBy })
      .from(schema.machineAccounts)
      .where(and(eq(schema.machineAccounts.orgId, agent.orgId), eq(schema.machineAccounts.id, id)));
    return { ...agent, machineId: row?.machineId ?? null, ownerUserId: row?.ownerId ?? null };
  }
  const [machine] = await db
    .select({ id: schema.machines.id })
    .from(schema.machines)
    .where(
      and(
        eq(schema.machines.orgId, agent.orgId),
        isNull(schema.machines.deletedAt),
        sql`(${schema.machines.kind} = 'managed' or ${schema.machines.pairedByUserId} = ${userId})`,
      ),
    )
    .orderBy(sql`${schema.machines.kind} = 'managed' desc`, schema.machines.createdAt)
    .limit(1);
  return { ...agent, machineId: machine?.id ?? null, ownerUserId: userId };
}

/** The computers the caller may give the agent (the same rule as `setAgentComputerTarget`), with their options. */
async function candidateMachines(
  db: Database,
  userId: string,
  orgId: string,
  admin: boolean,
  current: string | null,
): Promise<BrainMachineOptions[]> {
  const rows = await db
    .select()
    .from(schema.machines)
    .where(and(eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)));
  return rows
    .filter((m) => (admin || m.pairedByUserId === userId || m.id === current) && (mayBeHome(m) || m.id === current))
    .map((m) => ({ machineId: m.id, name: m.name, online: machineOnline(m), options: brainOptions(m) }));
}

async function agentMachine(db: Database, orgId: string, machineId: string | null) {
  if (!machineId) return null;
  const machine = await getMachine(db, orgId, machineId);
  return machine && !machine.deletedAt ? machine : null;
}

function view(
  agent: Agent,
  machine: MachineRow | null,
  machines: BrainMachineOptions[],
  accounts: BrainAccounts,
  userId: string,
): AgentBrainView {
  const brain = brainOf(agent.brain);
  return {
    agentId: agent.id,
    brain,
    model: brain === "model" ? null : agent.brainModel,
    effectiveModel: brain === "model" ? null : (agent.brainModel ?? defaultBrainModel(brain)),
    fallback: agent.brainFallback,
    extraUsage: agent.brainExtraUsage,
    computer: machine ? { machineId: machine.id, name: machine.name, online: machineOnline(machine) } : null,
    options: brainOptions(machine),
    machines,
    canEdit: true,
    account: agent.brainAccountId,
    effort: isBrainEffortSetting(agent.brainEffort) ? agent.brainEffort : null,
    speed: isBrainSpeed(agent.brainSpeed) ? agent.brainSpeed : "standard",
    contextTokens: isContextLimit(agent.contextTokens) ? agent.contextTokens : null,
    ...accounts,
    // The right hand keeps its audience: the switch says whether other people's DMs think with the plan.
    onlyOwner: isRightHand(agent) ? !agent.planForOthers : !answersOthers(audienceOf(agent), agent.ownerUserId),
    canUsePlans: agent.ownerUserId === userId,
    // Every plan that serves the workspace is listed for whoever chooses (ADR 0059 §3): no permission lends one.
    canUseOthersPlans: true,
    ownSignIn: Boolean(machine?.pairedByUserId) && machine?.pairedByUserId === agent.ownerUserId,
    ownUsage: machine?.executors?.ownUsage ?? {},
    autonomy: agentMissionApproval(agent),
    ...(isRightHand(agent) ? { scope: "workspace" as const } : {}),
  };
}

/** Postgres `foreign_key_violation`, as the driver raises it or wrapped by Drizzle (`cause`). */
function isForeignKeyViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 3; depth++) {
    if ((e as { code?: unknown }).code === "23503") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The team's right hand as the caller's own AI makes it (ADR 0137 §11): their row's plan, else no plan (the API brain,
 * which reads as "thinks with the workspace's"). Its plans are the caller's own, plus every one that serves the whole
 * workspace; on the computer of the account (asked for, else theirs), else where a plan would sign in.
 */
async function personalAgent(db: Database, agent: Agent, userId: string, account?: unknown): Promise<Agent> {
  const own = await personalBrain(db, agent.orgId, userId);
  const mine: Agent = {
    ...agent,
    brain: own?.brain ?? "model",
    brainModel: own?.brainModel ?? null,
    brainEffort: own?.brainEffort ?? null,
    brainAccountId: own?.brainAccountId ?? null,
    brainAccountLentBy: own?.brainAccountLentBy ?? null,
    brainFallback: false,
    brainExtraUsage: false,
    planForOthers: false,
  };
  // ponytail: the computer of their first plan, so plans on a second computer don't list here; loop over their
  // computers if self-hosted people connect plans on several.
  const [first] =
    account === undefined && !own
      ? await db
          .select({ id: schema.machineAccounts.id })
          .from(schema.machineAccounts)
          .where(
            and(
              eq(schema.machineAccounts.orgId, agent.orgId),
              eq(schema.machineAccounts.createdBy, userId),
              eq(schema.machineAccounts.status, "active"),
            ),
          )
          .orderBy(schema.machineAccounts.createdAt)
          .limit(1)
      : [];
  return { ...(await settingsAgent(db, mine, userId, account ?? first?.id)), ownerUserId: userId };
}

/** The workspace's key the right hand's model thinks with, in the order its calls take: null where they'd find none. */
async function workspaceKey(db: Database, agent: Agent) {
  const pinned = parseCustomModel(agent.model)?.credentialId ?? agent.credentialId;
  const [provider, defaults, rows] = await Promise.all([
    isAutoModel(agent.model) ? orgModelProvider(db, agent.orgId) : modelProvider(agent.model),
    defaultCredentials(db, agent.orgId),
    db
      .select({
        id: schema.providerCredentials.id,
        provider: schema.providerCredentials.provider,
        label: schema.providerCredentials.label,
        revokedAt: schema.providerCredentials.revokedAt,
      })
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.orgId, agent.orgId))
      .orderBy(asc(schema.providerCredentials.createdAt)),
  ]);
  const key = pinned ? rows.find((r) => r.id === pinned && !r.revokedAt) : providerKeyOf(rows, defaults, provider);
  return key ? { provider: key.provider, label: key.label } : null;
}

/** What everyone's DM with the right hand thinks with while they have no AI of their own (its `agents` row). */
async function workspaceAi(db: Database, agent: Agent, userId: string): Promise<RightHandWorkspaceAi> {
  const brain = brainOf(agent.brain);
  if (brain === "model" || !agent.brainAccountId)
    return { brain: "model", ownerId: null, servesYou: true, key: await workspaceKey(db, agent) };
  const ownerId = await accountOwnerOf(db, agent.orgId, agent.brainAccountId);
  const everyone = await servesEveryone(db, agent.orgId, agent.brainAccountId);
  return { brain, ownerId, servesYou: everyone || ownerId === userId };
}

async function personalView(db: Database, userId: string, orgId: string, agent: Agent): Promise<AgentBrainView> {
  const mine = await personalAgent(db, agent, userId);
  const machine = await agentMachine(db, orgId, mine.machineId);
  const [accounts, fallback] = await Promise.all([
    brainAccounts(db, userId, orgId, mine, machine),
    workspaceAi(db, agent, userId),
  ]);
  return {
    ...view(mine, machine, [], accounts, userId),
    scope: "mine",
    workspaceAi: fallback,
    // It serves the caller alone, never through a computer's own sign-in.
    onlyOwner: true,
    ownSignIn: false,
  };
}

/**
 * `PUT …/agents/{id}/brain` for the right hand's `mine` (ADR 0137 §11): any member gives their own DM with it one of
 * their plans, or someone else's that serves the whole workspace (ADR 0059 §3); `brain: "model"` or `account: null`
 * goes back to the workspace's. Audited.
 */
async function setPersonalBrain(
  deps: BrainDeps,
  userId: string,
  orgId: string,
  agent: Agent,
  input: AgentBrainInput,
): Promise<AgentBrainView> {
  const { db } = deps;
  const current = await personalBrain(db, orgId, userId);
  if (input.brain !== undefined && !isBrainKind(input.brain)) {
    throw new ValidationError("Choose model, claude_code, codex or cursor", "brain.invalid");
  }
  const from = current
    ? { brain: current.brain, model: current.brainModel, account: current.brainAccountId, effort: current.brainEffort }
    : null;
  const audit = (to: unknown) =>
    recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "agent.brain",
      target: { type: "agent", id: agent.id },
      details: { scope: "mine", from, to },
    });
  if (input.brain === "model" || input.account === null) {
    if (current) {
      await db
        .delete(schema.rightHandBrains)
        .where(and(eq(schema.rightHandBrains.orgId, orgId), eq(schema.rightHandBrains.userId, userId)));
      await audit(null);
    }
    return personalView(db, userId, orgId, agent);
  }
  const accountId = typeof input.account === "string" && input.account ? input.account : current?.brainAccountId;
  if (!accountId) {
    throw new ValidationError(
      "The team's right hand thinks with a plan signed in as an account",
      "brain.right_hand_account",
    );
  }
  const [placed] = await db
    .select({ machineId: schema.machineAccounts.machineId })
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, accountId)));
  const account = placed ? await getListedAccount(db, orgId, placed.machineId, accountId) : null;
  const brain = (input.brain as BrainKind | undefined) ?? (account?.kind as BrainKind | undefined);
  if (!account || !brain || account.kind !== brain || !isComputerBrain(brain)) {
    throw new ValidationError("Choose an account of this brain", "account.invalid", { brain: brain ?? null });
  }
  const lent = account.createdBy !== userId;
  if (account.createdBy === null || (lent && account.serves !== "everyone")) {
    throw new ForbiddenError("This plan thinks only for the person who connected it", "account.not_owner");
  }
  const changed = !current || current.brain !== brain || current.brainAccountId !== account.id;
  let moved: { id: string } | undefined;
  if (changed) {
    const machine = await agentMachine(db, orgId, account.machineId);
    const option = brainOptions(machine).find((o) => o.kind === brain);
    if (!machine || !option?.available) {
      throw new ConflictError(
        machine ? `${BRAIN_NAMES[brain]} isn't available on ${machine.name}` : "The plan's computer is gone",
        machine ? "brain.unavailable" : "brain.no_computer",
        { brain, reason: option?.reason ?? "no_computer", computer: machine?.name ?? null },
      );
    }
    // A login made for one agent thinks for one: the right hand may share it only with nobody else.
    if (!account.shared) {
      const [other] = await db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.orgId, orgId),
            eq(schema.agents.brainAccountId, account.id),
            ne(schema.agents.id, agent.id),
            isNull(schema.agents.archivedAt),
          ),
        );
      // Someone else's login stays with the agent that has it: only its owner moves it.
      if (other && (input.moveAccount !== true || lent)) {
        throw new ConflictError(`That account already thinks for ${other.name}`, "account.in_use", {
          agent: other.name,
          agentId: other.id,
        });
      }
      moved = other;
    }
  }
  const kindChanged = current?.brain !== brain;
  const carried = isAutoModel(current?.brainModel) ? AUTO_MODEL : null;
  const model =
    input.model !== undefined
      ? normalizeBrainModel(brain, input.model, kindChanged ? null : current?.brainModel)
      : kindChanged
        ? carried
        : (current?.brainModel ?? null);
  if (input.effort !== undefined && input.effort !== null && !isBrainEffortSetting(input.effort)) {
    throw new ValidationError("Choose auto, low, medium, high, xhigh or max", "brain.invalid_effort");
  }
  const effort =
    input.effort !== undefined
      ? (input.effort as BrainEffortSetting | null)
      : kindChanged
        ? null
        : current?.brainEffort;
  const accountChanged = current?.brainAccountId !== account.id;
  const lentBy = !lent ? null : accountChanged ? userId : (current?.brainAccountLentBy ?? userId);
  const values = {
    brain,
    brainModel: model,
    brainAccountId: account.id,
    brainAccountLentBy: lentBy,
    brainEffort: effort ?? null,
    updatedAt: new Date(),
  };
  const released = await db.transaction(async (tx) => {
    const released = moved ? await releaseAgents(tx, orgId, [account.id], new Date(), [moved.id]) : [];
    await tx
      .insert(schema.rightHandBrains)
      .values({ orgId, userId, ...values })
      .onConflictDoUpdate({ target: [schema.rightHandBrains.orgId, schema.rightHandBrains.userId], set: values });
    return released;
  });
  forgetAgents(orgId, released);
  await audit({ brain, model, account: account.id, effort: effort ?? null });
  if (moved) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.moved",
      target: { type: "machine_account", id: account.id },
      details: { from: moved.id, to: agent.id, scope: "mine" },
    });
  }
  if (lent && accountChanged) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.lent",
      target: { type: "machine_account", id: account.id },
      details: { agentId: agent.id, owner: account.createdBy, scope: "mine" },
    });
  }
  return personalView(db, userId, orgId, agent);
}

/** `GET …/agents/{id}/brain`: the choice, the computer and what it can offer. */
export async function getAgentBrain(
  deps: BrainDeps,
  userId: string,
  orgId: string,
  agentId: string,
  /** The team's right hand: `mine` or `workspace` (the default). Ignored for every other agent. */
  scope?: unknown,
): Promise<AgentBrainView> {
  const access = await agentBrainAccess(deps.db, userId, orgId, agentId, scope);
  if (access.scope === "mine") return personalView(deps.db, userId, orgId, access.agent);
  const { admin } = access;
  const agent = await settingsAgent(deps.db, access.agent, userId);
  const machineLook = agentMachine(deps.db, orgId, agent.machineId);
  const { providerCredentials } = schema;
  const [machine, machines, accounts, keys] = await Promise.all([
    machineLook,
    candidateMachines(deps.db, userId, orgId, admin, agent.machineId),
    machineLook.then((m) => brainAccounts(deps.db, userId, orgId, agent, m)),
    deps.db
      .select({ id: providerCredentials.id, provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.orgId, orgId), isNull(providerCredentials.revokedAt))),
  ]);
  return {
    ...view(agent, machine, machines, accounts, userId),
    keys,
    ...(access.scope ? { workspaceAi: await workspaceAi(deps.db, access.agent, userId) } : {}),
  };
}

/**
 * `GET …/brain-machines`: what a new agent could think with ("Criar agente"), before it exists: every computer of
 * the workspace (only admins create agents) with what each offers. The choice is saved on the agent once created.
 */
export async function newAgentBrainMachines(
  deps: BrainDeps,
  userId: string,
  orgId: string,
): Promise<BrainMachineOptions[]> {
  await requirePermission(deps.db, userId, orgId, "create_agents");
  return candidateMachines(deps.db, userId, orgId, true, null);
}

export interface AgentBrainInput {
  /** The team's right hand: `mine` (the caller's own AI) or `workspace` (the default). Ignored for any other agent. */
  scope?: unknown;
  brain?: unknown;
  /** Omitted = keep it (or the default when the brain changes); null = the brain's default. */
  model?: unknown;
  fallback?: unknown;
  extraUsage?: unknown;
  /**
   * "Atende outras pessoas" turned off (ADR 0059 §5): true, only its owner talks
   * to it; false, whoever its "who can talk" list lets in (everyone with no
   * list). Omitted = keep it; a switch onto a plan makes it its owner's only,
   * until its owner or an admin lets more people in.
   */
  onlyOwner?: unknown;
  /**
   * The account its computer brain runs with (ADR 0041): an account on the
   * agent's computer of the brain's kind, or null for the computer's own
   * sign-in. One of the agent's owner's accounts, chosen by its owner or an admin.
   * Omitted = keep it (cleared when the brain kind changes).
   */
  account?: unknown;
  /** The account thinks for another agent: take it from that one, which loses it (`releaseAgents`). */
  moveAccount?: unknown;
  /** `low`…`max`, `auto` (picked per run), or null for the CLI's default. Omitted = keep it. */
  effort?: unknown;
  /** `standard` or `fast`, kept through any change of brain, account or model. Omitted = keep it. */
  speed?: unknown;
  /** One of `CONTEXT_LIMITS`, or null for the model's window; kept through brain switches. Omitted = keep it. */
  contextTokens?: unknown;
}

const EVERYONE: AgentAudience = { mode: "everyone", userIds: [], roleIds: [] };

/**
 * Who it answers after this change: a switch onto a plan (`ontoPlan`) makes it its owner's only (ADR 0059 §5). From
 * one of its owner's plans to another it keeps whoever its owner already let in.
 */
function nextAudience(agent: Agent, ontoPlan: boolean, onlyOwner: boolean | undefined): AgentAudience {
  const current = audienceOf(agent);
  // One that already answers its owner alone keeps its mode: "Só algumas pessoas" with nobody picked stays that.
  const narrow = (a: AgentAudience) => (answersOthers(a, agent.ownerUserId) ? OWNER_ONLY : a);
  const base = ontoPlan ? narrow(current) : current;
  if (onlyOwner === undefined) return base;
  if (onlyOwner) return narrow(base);
  if (answersOthers(base, agent.ownerUserId)) return base;
  // Its "who can talk" list decides who comes back: it stays while the agent is its owner's only. One a person
  // restricted ("Só algumas pessoas ou papéis", even with nobody picked yet) stays restricted: never everyone.
  const kept = agent.audienceUserIds.length > 0 || agent.audienceRoleIds.length > 0 || agent.audienceMode === "people";
  return kept ? { mode: "people", userIds: agent.audienceUserIds, roleIds: agent.audienceRoleIds } : EVERYONE;
}

/**
 * `PUT …/agents/{id}/brain` (an admin or the agent's owner). Audited, with `options.audit` added to the entry. What it
 * thinks with becomes what new agents start with, unless `options.remember` is false.
 */
export async function setAgentBrain(
  deps: BrainDeps,
  userId: string,
  orgId: string,
  agentId: string,
  input: AgentBrainInput,
  options: {
    remember?: boolean;
    audit?: Record<string, unknown>;
    /** Called in its transaction when the save lets more people talk to it on its owner's plan (`planOpened`). */
    onPlanOpened?: () => void;
  } = {},
): Promise<AgentBrainView> {
  const access = await agentBrainAccess(deps.db, userId, orgId, agentId, input.scope);
  const { admin, membership } = access;
  if (access.scope === "mine") return setPersonalBrain(deps, userId, orgId, access.agent, input);
  const rightHand = isRightHand(access.agent);
  const agent = await settingsAgent(deps.db, access.agent, userId, input.account);
  const from = brainOf(agent.brain);
  if (input.brain !== undefined && !isBrainKind(input.brain)) {
    throw new ValidationError("Choose model, claude_code, codex or cursor", "brain.invalid");
  }
  if (input.fallback !== undefined && typeof input.fallback !== "boolean") {
    throw new ValidationError("fallback is on or off", "brain.invalid");
  }
  if (input.extraUsage !== undefined && typeof input.extraUsage !== "boolean") {
    throw new ValidationError("extraUsage is on or off", "brain.invalid");
  }
  if (input.onlyOwner !== undefined && typeof input.onlyOwner !== "boolean") {
    throw new ValidationError("onlyOwner is on or off", "brain.invalid");
  }
  const brain = (input.brain as BrainKind | undefined) ?? from;
  const changed = brain !== from;
  const [machine, machines] = await Promise.all([
    agentMachine(deps.db, orgId, agent.machineId),
    candidateMachines(deps.db, userId, orgId, admin, agent.machineId),
  ]);
  if (changed && isComputerBrain(brain)) {
    const option = brainOptions(machine).find((o) => o.kind === brain);
    if (!option?.available) {
      throw new ConflictError(
        machine
          ? `${BRAIN_NAMES[brain]} isn't available on ${machine.name}`
          : "The agent needs a connected computer first",
        machine ? "brain.unavailable" : "brain.no_computer",
        { brain, reason: option?.reason ?? "no_computer", computer: machine?.name ?? null },
      );
    }
  }
  // "Automático" is one choice for every brain: it stays through a switch (and while on the API brain, for
  // the next one), so an agent born automatic is automatic on Claude Code or Codex too. A fixed model belongs to
  // its brain: another brain starts on its default.
  const carried = isAutoModel(agent.brainModel) ? AUTO_MODEL : null;
  const model =
    input.model !== undefined
      ? normalizeBrainModel(brain, input.model, changed ? null : agent.brainModel)
      : brain === "model" || changed
        ? carried
        : agent.brainModel;
  const fallback = (input.fallback as boolean | undefined) ?? agent.brainFallback;
  // The right hand put on a plan starts with that plan's switches off: neither paid extra usage nor "Atende outras
  // pessoas" is carried over from whoever set them before (an admin while it was on a key, or another plan's owner).
  const newPlan = rightHand && typeof input.account === "string" && input.account !== access.agent.brainAccountId;
  const next = await nextBrainAccount(deps.db, userId, orgId, agent, brain, changed, machine, input.account, {
    move: input.moveAccount === true,
    admin,
  });
  const account = next.id;
  // On a plan the right hand thinks with an account, never a computer's own sign-in: that names its computer.
  if (rightHand && brain !== "model" && !account) {
    throw new ValidationError(
      "The team's right hand thinks with a plan signed in as an account",
      "brain.right_hand_account",
    );
  }
  // Its plan is whoever signed it in: they give it to the right hand, or someone who may use other people's plans.
  // "Atende outras pessoas" is as for any agent on its owner's plan (ADR 0059 §5): the plan's owner chooses, an admin
  // may override, and the plan's owner hears it by email (`planOpened` below).
  const handsOver =
    rightHand && agent.ownerUserId !== userId && account !== null && account !== access.agent.brainAccountId;
  if (handsOver && !(await servesEveryone(deps.db, orgId, account))) {
    throw new ForbiddenError("Only the plan's owner gives it to the team's right hand", "account.not_owner");
  }
  // Who gave it someone else's plan (ADR 0059 §3): kept while the account stays, else whoever gives one now.
  const accountChanged = account !== agent.brainAccountId;
  const lentBy = !accountChanged ? (agent.brainAccountLentBy ?? null) : next.lent || handsOver ? userId : null;
  const lentNow = accountChanged && lentBy !== null;
  const planOwner = lentBy && account ? await accountOwnerOf(deps.db, orgId, account) : agent.ownerUserId;
  // The plan changes hands (someone else's given now, or back from one): it starts as on a new plan.
  const ownerSwitch = accountChanged && (lentBy !== null || agent.brainAccountLentBy != null);
  const extraBefore = newPlan || ownerSwitch ? false : agent.brainExtraUsage;
  const extraUsage = (input.extraUsage as boolean | undefined) ?? extraBefore;
  // Paid extra usage bills the plan's owner (the agent's, unless it was lent): an admin picks the account, not this.
  // A plan that changes hands starts with it off, so only its owner may send it on with that change.
  if (input.extraUsage !== undefined && extraUsage !== extraBefore && planOwner !== userId) {
    throw new ForbiddenError(
      "Only the agent's owner turns its plan's paid extra usage on or off",
      "brain.extra_owner_only",
    );
  }
  if (input.effort !== undefined && input.effort !== null && !isBrainEffortSetting(input.effort)) {
    throw new ValidationError("Choose auto, low, medium, high, xhigh or max", "brain.invalid_effort");
  }
  const effort = input.effort === undefined ? agent.brainEffort : (input.effort as BrainEffortSetting | null);
  if (input.speed !== undefined && !isBrainSpeed(input.speed)) {
    throw new ValidationError("Choose standard or fast", "brain.invalid_speed");
  }
  // The right hand has no speed of its own: each person's DM thinks with their plan.
  const speed = rightHand || input.speed === undefined ? agent.brainSpeed : input.speed;
  if (input.contextTokens !== undefined && input.contextTokens !== null && !isContextLimit(input.contextTokens)) {
    throw new ValidationError("Choose 200000, 400000 or 1000000 tokens", "brain.invalid_context");
  }
  const contextTokens =
    input.contextTokens === undefined ? agent.contextTokens : (input.contextTokens as number | null);
  // The right hand keeps its audience: "Atende outras pessoas" is its own switch, off when it moves onto a plan.
  // Onto someone else's plan it starts on its owner alone, as onto a plan (ADR 0059 §5).
  // Already on a plan, another kind of plan (Claude to ChatGPT) is not a move onto one: whoever its owner let in
  // stays, as when only the account or the model changes. A plan that changes hands still starts on its owner alone.
  const ontoPlan = isComputerBrain(brain) && (ownerSwitch || (changed && !isComputerBrain(from)));
  const to = rightHand ? audienceOf(agent) : nextAudience(agent, ontoPlan, input.onlyOwner as boolean | undefined);
  const audience = to.mode === agent.audienceMode ? null : to;
  const planForOthers = !rightHand
    ? agent.planForOthers
    : input.onlyOwner !== undefined
      ? !input.onlyOwner
      : (changed && isComputerBrain(brain)) || newPlan
        ? false
        : agent.planForOthers;
  // Choosing a model its plan refused for this key (switched off there) asks the plan again: the next turn tries it.
  const picked = typeof input.model === "string" ? planModelById(input.model) : undefined;
  if (account && picked) {
    const { machineAccounts } = schema;
    await deps.db
      .update(machineAccounts)
      .set({ usage: sql`${machineAccounts.usage} #- ${`{models,${picked.id}}`}::text[]` })
      .where(
        and(
          eq(machineAccounts.orgId, orgId),
          eq(machineAccounts.id, account),
          sql`${machineAccounts.usage}->'models' ? ${picked.id}`,
        ),
      );
  }
  const accounts = await brainAccounts(deps.db, userId, orgId, agent, machine);
  const thinks =
    changed ||
    model !== agent.brainModel ||
    fallback !== agent.brainFallback ||
    extraUsage !== agent.brainExtraUsage ||
    account !== agent.brainAccountId ||
    effort !== agent.brainEffort ||
    speed !== agent.brainSpeed ||
    contextTokens !== agent.contextTokens ||
    planForOthers !== agent.planForOthers;
  if (!thinks && !audience) return view(agent, machine, machines, accounts, userId);
  const { row, released } = await deps.db.transaction(async (tx) => {
    // A login made for one agent thinks for one: the check is taken again under its row's lock, so two agents
    // picking it at once can't both have it.
    if (account && account !== agent.brainAccountId) {
      const [locked] = await tx
        .select({ shared: schema.machineAccounts.shared })
        .from(schema.machineAccounts)
        .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, account)))
        .for("update");
      if (locked && !locked.shared) {
        const [other] = await tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.orgId, orgId),
              eq(schema.agents.brainAccountId, account),
              ne(schema.agents.id, agentId),
              isNull(schema.agents.archivedAt),
            ),
          );
        if (other && other.id !== next.from?.agentId) {
          throw new ConflictError("That account already thinks for another agent", "account.in_use");
        }
        // Nor for people's right hand (ADR 0137 §11) too: the screens said it moves here.
        if (!rightHand) {
          await tx
            .delete(schema.rightHandBrains)
            .where(and(eq(schema.rightHandBrains.orgId, orgId), eq(schema.rightHandBrains.brainAccountId, account)));
        }
      }
    }
    const released = next.from ? await releaseAgents(tx, orgId, [next.from.accountId]) : [];
    const [row] = await tx
      .update(schema.agents)
      .set({
        brain,
        brainModel: model,
        brainFallback: fallback,
        brainExtraUsage: extraUsage,
        brainAccountId: account,
        brainAccountLentBy: lentBy,
        brainEffort: effort,
        brainSpeed: speed,
        contextTokens,
        planForOthers,
        // The people and roles lists stay while it is its owner's only, for when it is let out again.
        ...(audience
          ? {
              audienceMode: audience.mode,
              ...(audience.mode === "everyone" ? { audienceUserIds: [], audienceRoleIds: [] } : {}),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)))
      .returning()
      .catch((error: unknown) => {
        // The account was removed meanwhile (the computer, its owner): the same answer as a stale choice.
        if (account && isForeignKeyViolation(error)) {
          throw new ValidationError("That account is no longer on this computer", "account.invalid");
        }
        throw error;
      });
    // Onto a plan it answered nobody on it before: one that keeps answering others opens that plan to them.
    const planFrom = (changed || ownerSwitch) && isComputerBrain(brain) ? OWNER_ONLY : audienceOf(agent);
    let opened = false;
    if (row && audience) {
      await dropMailIfWidened(tx, orgId, agentId, agent.ownerUserId, audienceOf(agent), audienceOf(row), userId);
      const to = { ...audience, consultable: agent.consultable };
      opened = await audienceChanged(tx, orgId, userId, row, audienceOf(agent), to, planFrom);
    } else if (row && rightHand) {
      if (planForOthers && !agent.planForOthers) {
        const plan = { id: row.id, brain: row.brain, ownerUserId: agent.ownerUserId };
        opened = await planOpened(tx, orgId, userId, plan, OWNER_ONLY, audienceOf(row));
      }
    } else if (row && changed) opened = await planOpened(tx, orgId, userId, row, planFrom, audienceOf(row));
    if (opened) options.onPlanOpened?.();
    return { row, released };
  });
  caches.agents.delete(`${orgId}:${agentId}`);
  if (audience) caches.agents.delete(`${orgId}:team`);
  forgetAgents(orgId, released);
  // Another model chosen: the note that its model left its plan's list is done.
  if (changed || model !== agent.brainModel || account !== agent.brainAccountId) {
    await resolveNotifications(deps, orgId, {
      groupKeyPrefix: planModelDroppedGroup(agentId),
      kind: "plan_model_dropped",
    });
  }
  if (thinks) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "agent.brain",
      target: { type: "agent", id: agentId },
      details: {
        from: {
          brain: from,
          model: agent.brainModel,
          fallback: agent.brainFallback,
          extraUsage: agent.brainExtraUsage,
          account: agent.brainAccountId,
          effort: agent.brainEffort,
          speed: agent.brainSpeed,
          contextTokens: agent.contextTokens,
        },
        to: { brain, model, fallback, extraUsage, account, effort, speed, contextTokens },
        ...(rightHand ? { planForOthers: { from: agent.planForOthers, to: planForOthers } } : {}),
        ...options.audit,
      },
    });
  }
  if (lentNow && account) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.lent",
      target: { type: "machine_account", id: account },
      details: { agentId, owner: planOwner },
    });
  }
  if (next.from) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.moved",
      target: { type: "machine_account", id: next.from.accountId },
      details: { from: next.from.agentId, to: agentId },
    });
  }
  const saved = row ?? {
    ...agent,
    brain,
    brainModel: model,
    brainFallback: fallback,
    brainExtraUsage: extraUsage,
    brainAccountId: account,
    brainAccountLentBy: lentBy,
    brainEffort: effort,
    brainSpeed: speed,
    contextTokens,
    planForOthers,
    ...(audience ? { audienceMode: audience.mode } : {}),
  };
  // Never what new agents start with: its plan and its switch are its own.
  if (thinks && options.remember !== false && !rightHand) {
    await rememberAgentSetup(deps.db, membership, setupOfAgent(saved));
  }
  // Another AI, account or model, or extra usage on: what waited on the old one's plan or budget goes on now, in its
  // line's order.
  if (
    changed ||
    model !== agent.brainModel ||
    account !== agent.brainAccountId ||
    fallback !== agent.brainFallback ||
    (extraUsage && !agent.brainExtraUsage)
  )
    await wakeAgentUsageWaits(deps.db, orgId, agentId).catch(() => null);
  // The account's `usedBy` changed with it.
  // The right hand's row is on no computer: shown as its settings see it again.
  const shown = rightHand ? await settingsAgent(deps.db, saved, userId) : saved;
  const shownMachine = shown.machineId === machine?.id ? machine : await agentMachine(deps.db, orgId, shown.machineId);
  const fresh =
    account !== agent.brainAccountId || shownMachine !== machine
      ? await brainAccounts(deps.db, userId, orgId, shown, shownMachine)
      : accounts;
  return view(shown, shownMachine, machines, fresh, userId);
}

/**
 * The account the agent will run with (ADR 0041 §4, ADR 0059 §1–3): kept
 * when nothing asks otherwise, cleared when the brain kind changes. The choice is among the
 * accounts on the agent's computer, of the brain's kind, that serve everyone in the workspace or are the agent's
 * owner's (one made for one agent that another uses only with `move`), or the computer's own sign-in when they
 * connected it. The agent's owner or an admin chooses. Another person's account (`lent`) is never taken from an
 * agent that thinks with it.
 */
async function nextBrainAccount(
  db: Database,
  userId: string,
  orgId: string,
  agent: Pick<Agent, "id" | "brainAccountId" | "ownerUserId">,
  brain: BrainKind,
  changed: boolean,
  machine: MachineRow | null,
  input: unknown,
  options: { move: boolean; admin: boolean },
): Promise<{ id: string | null; lent?: boolean; from?: { accountId: string; agentId: string } }> {
  const kept = changed ? null : agent.brainAccountId;
  if (input === undefined) return { id: kept };
  if (input !== null && typeof input !== "string") {
    throw new ValidationError("Choose an account on the agent's computer", "account.invalid");
  }
  const wanted = input || null;
  if (wanted === kept) return { id: kept };
  const owner = agent.ownerUserId;
  const chooses = options.admin || owner === userId;
  if (wanted === null) {
    if (machine && !(chooses && owner !== null && machine.pairedByUserId === owner)) {
      throw new ForbiddenError(
        "The computer's own sign-in thinks only for the agents of whoever connected that computer",
        "account.not_owner",
      );
    }
    return { id: null };
  }
  const row = machine && isComputerBrain(brain) ? await getListedAccount(db, orgId, machine.id, wanted) : null;
  if (!row || row.kind !== brain) {
    throw new ValidationError("Choose an account of this brain on the agent's computer", "account.invalid", {
      brain,
    });
  }
  const lent = row.createdBy !== owner;
  if (!chooses || owner === null || row.createdBy === null || (lent && row.serves !== "everyone")) {
    throw new ForbiddenError("This plan thinks only for its owner's agents", "account.not_owner");
  }
  // Made for all of its owner's agents there (protocol 29): it thinks for this one too.
  if (row.shared) return { id: row.id, lent };
  const [other] = await db
    .select({ id: schema.agents.id, name: schema.agents.name })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        eq(schema.agents.brainAccountId, row.id),
        ne(schema.agents.id, agent.id),
        isNull(schema.agents.archivedAt),
      ),
    );
  // Someone else's login stays with the agent that has it: only its owner moves it.
  if (other && (!options.move || lent)) {
    throw new ConflictError(`That account already thinks for ${other.name}`, "account.in_use", {
      agent: other.name,
      agentId: other.id,
    });
  }
  return { id: row.id, lent, ...(other ? { from: { accountId: row.id, agentId: other.id } } : {}) };
}

/** The outbox job telling a plan's owner that someone else gave it to an agent (`queuePlanLent`). */
export const PLAN_LENT_JOB = "agent.plan_lent";

/** The account serves everyone in the workspace (`machine_accounts.serves`, ADR 0059 §3). */
async function servesEveryone(db: Executor, orgId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ serves: schema.machineAccounts.serves })
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, accountId)));
  return row?.serves === "everyone";
}

async function accountOwnerOf(db: Executor, orgId: string, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: schema.machineAccounts.createdBy })
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, accountId)));
  return row?.ownerId ?? null;
}

/**
 * `POST …/ai-accounts/{id}/take-back` (ADR 0059 §3, amended 2026-11-04): the plan's owner takes their account
 * back from an agent someone else gave it to (`agentId`), or from every such agent. Each goes back as when an account
 * goes (`releaseAgents`), its inbox note is done, and each is audited (`account.taken_back`).
 */
export async function takeBackPlan(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  accountId: string,
  agentId?: string,
): Promise<{ agentIds: string[] }> {
  await requirePermission(deps.db, userId, orgId, "read");
  const owner = await accountOwnerOf(deps.db, orgId, accountId);
  if (!owner) throw new NotFoundError("Account not found");
  if (owner !== userId) throw new ForbiddenError("Only the plan's owner takes it back", "account.not_owner");
  const lent = await deps.db
    .select({ id: schema.agents.id, lentBy: schema.agents.brainAccountLentBy })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        eq(schema.agents.brainAccountId, accountId),
        isNotNull(schema.agents.brainAccountLentBy),
        agentId ? eq(schema.agents.id, agentId) : undefined,
      ),
    );
  const ids = await releaseAgents(
    deps.db,
    orgId,
    [accountId],
    new Date(),
    lent.map((a) => a.id),
  );
  forgetAgents(orgId, ids);
  // People's own AI for the right hand (ADR 0137 §11) given this plan: back to the workspace's.
  const rightHand = agentId ? isRightHand(await getAgent(deps.db, orgId, agentId)) : true;
  const personal = rightHand
    ? await deps.db
        .delete(schema.rightHandBrains)
        .where(
          and(
            eq(schema.rightHandBrains.orgId, orgId),
            eq(schema.rightHandBrains.brainAccountId, accountId),
            isNotNull(schema.rightHandBrains.brainAccountLentBy),
            ne(schema.rightHandBrains.userId, userId),
          ),
        )
        .returning({ userId: schema.rightHandBrains.userId })
    : [];
  // Their right hand's user lets the sign-in go now, not at the next change (`machineAgents`).
  if (personal.length > 0) await publishMachineAgentsChanged(deps.pubsub, orgId);
  for (const p of personal) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.taken_back",
      target: { type: "machine_account", id: accountId },
      details: { scope: "mine", lentBy: p.userId },
    });
  }
  for (const a of lent.filter((x) => ids.includes(x.id))) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.taken_back",
      target: { type: "machine_account", id: accountId },
      details: { agentId: a.id, lentBy: a.lentBy },
    });
  }
  await resolveNotifications(deps, orgId, {
    groupKeyPrefix: planLentGroup(accountId, agentId),
    userIds: [userId],
    kind: "plan_lent",
  });
  return { agentIds: ids };
}

/** The inbox note that a plan serves the whole workspace now (`plan_serves`), with "Mudar para Só eu". */
export const planServesGroup = (accountId: string) => `plan_serves:${accountId}`;

/**
 * `PUT …/ai-accounts/{id}/serves` (ADR 0059 §3): who a plan thinks for, `everyone` in the workspace or only its
 * `owner`. Only the person who connected it chooses, for every login of that account. "Só eu" moves the agents of other
 * people off it and people's own AI for the right hand back to the workspace's, as when a plan is taken back
 * (`releaseAgents`). Audited (`account.serves`); its `plan_serves` note is done.
 */
export async function setAccountServes(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  accountId: string,
  serves: unknown,
): Promise<{ serves: PlanServes; agentIds: string[] }> {
  if (!isPlanServes(serves)) throw new ValidationError("Choose everyone or owner", "account.invalid_serves");
  await requirePermission(deps.db, userId, orgId, "read");
  const [row] = await deps.db
    .select()
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, accountId)));
  if (!row || !LISTED_ACCOUNT_STATUSES.includes(row.status)) throw new NotFoundError("Account not found");
  if (row.createdBy !== userId) {
    throw new ForbiddenError("Only the person who connected this plan chooses who it serves", "account.not_owner");
  }
  const logins = (await sameLogins(deps.db, row)).map((l) => l.id);
  const changed = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.machineAccounts)
      .set({ serves, updatedAt: new Date() })
      .where(
        and(
          eq(schema.machineAccounts.orgId, orgId),
          inArray(schema.machineAccounts.id, logins),
          ne(schema.machineAccounts.serves, serves),
        ),
      )
      .returning({ id: schema.machineAccounts.id });
    if (updated.length === 0 || serves === "everyone")
      return { ids: updated.map((u) => u.id), agentIds: [], people: 0 };
    const others = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, orgId),
          inArray(schema.agents.brainAccountId, logins),
          isNull(schema.agents.builtin),
          sql`${schema.agents.ownerUserId} is distinct from ${userId}`,
        ),
      );
    const agentIds = await releaseAgents(
      tx,
      orgId,
      logins,
      new Date(),
      others.map((a) => a.id),
    );
    const people = await tx
      .delete(schema.rightHandBrains)
      .where(
        and(
          eq(schema.rightHandBrains.orgId, orgId),
          inArray(schema.rightHandBrains.brainAccountId, logins),
          ne(schema.rightHandBrains.userId, userId),
        ),
      )
      .returning({ userId: schema.rightHandBrains.userId });
    return { ids: updated.map((u) => u.id), agentIds, people: people.length };
  });
  forgetAgents(orgId, changed.agentIds);
  if (changed.people > 0) await publishMachineAgentsChanged(deps.pubsub, orgId);
  for (const id of changed.ids) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.serves",
      target: { type: "machine_account", id },
      details: { serves, agents: changed.agentIds },
    });
  }
  for (const id of logins) {
    await resolveNotifications(deps, orgId, {
      groupKeyPrefix: planServesGroup(id),
      userIds: [userId],
      kind: "plan_serves",
    });
  }
  if (changed.ids.length > 0) await publishAccountsChanged(deps.pubsub, orgId, row.machineId);
  return { serves, agentIds: changed.agentIds };
}

// ── Missions ────────────────────────────────────────────────────────────────

/** The brain a mission's executor means (`claude` → Claude Code, `codex` → Codex, `agent` → the model). */
export const executorBrain = (executor: string): BrainKind =>
  executor === "codex" ? "codex" : executor === "agent" ? "model" : "claude_code";

export interface MissionBrainView {
  missionId: string;
  /** The override as stored (null = from the executor). */
  brain: BrainKind | null;
  model: string | null;
  effectiveBrain: BrainKind;
  /** What it runs with: the override, the agent's model for that brain, or the brain's default. */
  effectiveModel: string | null;
  options: BrainOption[];
  /** Before Start, the owner or someone who decides. */
  canSetBrain: boolean;
  /** Any time while it is open, the owner or someone who decides. */
  canSetModel: boolean;
}

async function missionBrainView(
  deps: Pick<MissionDeps, "db">,
  mission: MissionRow,
  role: string,
): Promise<MissionBrainView> {
  const [machine, agent] = await Promise.all([
    agentMachine(deps.db, mission.orgId, mission.machineId),
    getAgent(deps.db, mission.orgId, mission.agentId),
  ]);
  const effectiveBrain = isBrainKind(mission.brain) ? mission.brain : executorBrain(mission.executor);
  const agentModel = agent && brainOf(agent.brain) === effectiveBrain ? agent.brainModel : null;
  const actor = role === "owner" || role === "decide";
  const open = OPEN_MISSION_STATUSES.includes(mission.status);
  return {
    missionId: mission.id,
    brain: isBrainKind(mission.brain) ? mission.brain : null,
    model: mission.brainModel,
    effectiveBrain,
    effectiveModel:
      effectiveBrain === "model" ? null : (mission.brainModel ?? agentModel ?? defaultBrainModel(effectiveBrain)),
    options: brainOptions(machine),
    canSetBrain: actor && mission.status === "proposed",
    canSetModel: actor && open,
  };
}

/** `GET …/missions/{id}/brain`, for whoever reads the mission's conversation. */
export async function getMissionBrain(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  return missionBrainView(deps, mission, role);
}

/**
 * `PUT …/missions/{id}/brain` (the owner or someone who decides): the brain
 * only before Start; its model any time while the mission is open (the next
 * session or task picks it up). Audited.
 */
export async function setMissionBrain(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  input: { brain?: unknown; model?: unknown },
): Promise<MissionBrainView> {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "change who does the work");
  requireOpen(mission);
  if (input.brain !== undefined && input.brain !== null && !isBrainKind(input.brain)) {
    throw new ValidationError("Choose model, claude_code or codex", "brain.invalid");
  }
  const brain = input.brain === undefined ? mission.brain : (input.brain as BrainKind | null);
  const brainChanged = (brain ?? null) !== (mission.brain ?? null);
  if (brainChanged && mission.status !== "proposed") {
    throw new ConflictError("Who does the work is chosen before Start", "mission.wrong_status", {
      status: mission.status,
    });
  }
  const effective = isBrainKind(brain) ? brain : executorBrain(mission.executor);
  if (brainChanged && isComputerBrain(effective)) {
    const machine = await agentMachine(deps.db, orgId, mission.machineId);
    const option = brainOptions(machine).find((o) => o.kind === effective);
    if (!option?.available) {
      throw new ConflictError(
        `${effective === "codex" ? "Codex" : "Claude Code"} isn't available on the mission's computer`,
        machine ? "brain.unavailable" : "brain.no_computer",
        { brain: effective, reason: option?.reason ?? "no_computer", computer: machine?.name ?? null },
      );
    }
  }
  const model =
    input.model !== undefined
      ? effective === "model" && (input.model === null || input.model === "")
        ? null
        : normalizeBrainModel(effective, input.model, brainChanged ? null : mission.brainModel)
      : brainChanged
        ? null
        : mission.brainModel;
  // A mission names its model; "Automático" is the agent's own setting, which a mission without one follows.
  if (isAutoModel(model) && model !== mission.brainModel) {
    throw new ValidationError("Choose a model for the mission", "brain.invalid_model", { brain: effective });
  }
  if (!brainChanged && model === mission.brainModel) return missionBrainView(deps, mission, role);
  const row = await deps.db.transaction(async (tx) => {
    const [next] = await tx
      .update(schema.missions)
      .set({ brain: brain ?? null, brainModel: model, updatedAt: new Date() })
      .where(sql`${schema.missions.id} = ${mission.id}::uuid`)
      .returning();
    const details = {
      from: { brain: mission.brain, model: mission.brainModel },
      to: { brain: brain ?? null, model },
    };
    await recordMissionEvent(tx, mission, "brain_changed", { by: userId, ...details });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.brain_changed",
      target: { type: "mission", id: mission.id },
      details,
    });
    return next;
  });
  const current = row ?? { ...mission, brain: brain ?? null, brainModel: model };
  await publishMissionEvent(deps, current, "settings", { brain: brain ?? null, brainModel: model });
  return missionBrainView(deps, current, role);
}

/**
 * What thinks for an agent, for wherever the agent is shown (DM header,
 * profile, cards): the brain, its model's label ("Sonnet"; null for the
 * model brain, which shows the agent's model) and the computer's name, only
 * for those who may see it (admins and the agent's owner, like Quem pensa).
 * On a plan, the account it thinks with and that plan's limits, for everyone
 * (ADR 0063 §4, §5).
 */
export interface AgentBrainSummary {
  kind: BrainKind;
  model: string | null;
  computer?: string;
  /** A key account's coding plan (`zai`…): its maker's model thinks, through Claude Code. */
  provider?: string;
  /** The account's name ("Claude 2"); a computer's own sign-in by its maker and plan ("Claude Max"). */
  account?: string;
  /** That account's limits as the runner last reported them; absent: not known yet. */
  usage?: PlanUsage;
  /** Set to Rápida where that applies to what it thinks with (ADR 0149); absent: standard speed. */
  speed?: "fast";
  /** An API brain on Automático: the maker its models come from (`agentBrainLines`), whose logo the app shows. */
  maker?: string;
}

/**
 * The label of a computer brain's model ("opus" → "Opus", "GLM-5.3" on a plan; a typed Codex model as is): what it
 * runs, so a plan's model kept while Claude thinks reads as Sonnet.
 */
export function brainModelLabel(
  kind: BrainKind,
  model: string | null | undefined,
  provider?: string | null,
): string | null {
  if (kind === "model") return null;
  const plan = kind === "claude_code" ? planOf(provider) : undefined;
  if (plan) return planModel(plan, isAutoModel(model) ? null : model).label;
  const stored = model ?? defaultBrainModel(kind);
  if (!stored) return null;
  const value = kind === "claude_code" && !isAutoModel(stored) ? claudeCodeModel(undefined, stored) : stored;
  return brainModelOptions(kind).find((o) => o.value === value)?.label ?? value;
}

/** Each agent's brain summary for this viewer (one query for the computers, one for the accounts). */
export async function agentBrainSummaries(
  db: Database,
  viewerId: string,
  orgId: string,
  agents: readonly {
    id: string;
    brain: string;
    brainModel: string | null;
    machineId: string | null;
    ownerUserId: string | null;
    brainAccountId?: string | null;
    brainSpeed?: string;
    builtin?: string | null;
  }[],
): Promise<Map<string, AgentBrainSummary>> {
  const out = new Map<string, AgentBrainSummary>();
  const computerIds = [
    ...new Set(agents.filter((a) => brainOf(a.brain) !== "model" && a.machineId).map((a) => a.machineId as string)),
  ];
  const accountIds = [
    ...new Set(
      agents.filter((a) => brainOf(a.brain) !== "model" && a.brainAccountId).map((a) => a.brainAccountId as string),
    ),
  ];
  const [membership, machines, accounts] = await Promise.all([
    computerIds.length ? getMembership(db, viewerId, orgId) : Promise.resolve(null),
    computerIds.length
      ? db
          .select({
            id: schema.machines.id,
            name: schema.machines.name,
            deletedAt: schema.machines.deletedAt,
            pairer: schema.machines.pairedByUserId,
            executors: schema.machines.executors,
          })
          .from(schema.machines)
          .where(and(eq(schema.machines.orgId, orgId), inArray(schema.machines.id, computerIds)))
      : Promise.resolve([]),
    accountIds.length
      ? db
          .select({
            id: schema.machineAccounts.id,
            label: schema.machineAccounts.label,
            provider: schema.machineAccounts.provider,
            usage: schema.machineAccounts.usage,
          })
          .from(schema.machineAccounts)
          .where(and(eq(schema.machineAccounts.orgId, orgId), inArray(schema.machineAccounts.id, accountIds)))
      : Promise.resolve([]),
  ]);
  const live = new Map(machines.filter((m) => !m.deletedAt).map((m) => [m.id, m]));
  const accountById = new Map(accounts.map((r) => [r.id, r]));
  const manages = membership !== null && !readRefusal(membership.standing) && can(membership, "manage_agents");
  for (const a of agents) {
    const kind = brainOf(a.brain);
    const machine = a.machineId ? live.get(a.machineId) : undefined;
    const computer = machine && (manages || a.ownerUserId === viewerId) ? machine.name : undefined;
    const row = kind !== "model" && a.brainAccountId ? accountById.get(a.brainAccountId) : undefined;
    const provider = kind === "claude_code" ? (row?.provider ?? undefined) : undefined;
    const ownPlan = kind === "claude_code" ? machine?.executors?.claude?.plan : undefined;
    // With no account, the computer's own sign-in thinks only for its pairer's agents (ADR 0059 §3).
    const own =
      kind !== "model" && !a.brainAccountId && machine?.pairer && machine.pairer === a.ownerUserId
        ? {
            account: ownPlan
              ? `${defaultAccountLabel(kind)} ${ownPlan[0]?.toUpperCase()}${ownPlan.slice(1)}`
              : defaultAccountLabel(kind),
            usage: machine.executors?.ownUsage?.[kind],
          }
        : null;
    const plan = row ? { account: row.label, usage: row.usage ?? undefined } : own;
    out.set(a.id, {
      kind,
      model: brainModelLabel(kind, a.brainModel, provider),
      ...(kind !== "model" && computer ? { computer } : {}),
      ...(provider ? { provider } : {}),
      ...(plan ? { account: plan.account } : {}),
      ...(plan?.usage ? { usage: plan.usage } : {}),
      ...(a.brainSpeed === "fast" &&
      !isRightHand(a) &&
      speedFits({ kind, provider: row?.provider, model: a.brainModel })
        ? { speed: "fast" as const }
        : {}),
    });
  }
  return out;
}

// ── Contas de IA ────────────────────────────────────────────────────────────

/** A computer of the organization as the AI accounts page needs it. */
export interface AiComputer {
  machineId: string;
  name: string;
  online: boolean;
  /** The caller connected it. */
  mine: boolean;
  /** The caller adds accounts there (they connected it, or nobody did), on a runner that knows accounts. */
  canAdd: boolean;
  /** Its runner takes coding plans' keys (protocol 20). */
  keys: boolean;
  /**
   * A new sign-in there thinks for all of the caller's agents on it (protocol 29): Claude's, ChatGPT's and a
   * coding plan's key.
   */
  shares: {
    claude_code: boolean;
    codex: boolean;
    cursor: boolean;
    opencode: boolean;
    grok: boolean;
    antigravity: boolean;
    key: boolean;
  };
  /** Why a CLI of `brains` can't think there, as `brainOptions` says it. */
  off: Partial<Record<BrainKind, BrainUnavailable>>;
  /** What it can think with now: Claude Code (Claude and the coding plans), Codex (ChatGPT), Cursor, OpenCode, Grok, Antigravity. */
  brains: {
    claude_code: boolean;
    codex: boolean;
    cursor: boolean;
    opencode: boolean;
    grok: boolean;
    antigravity: boolean;
  };
  /**
   * "Conta deste computador": each CLI's own sign-in there, on a computer the caller connected (it is theirs, and
   * the agents on it think with it when no account is picked). Claude Code when `claude auth status` said it is
   * signed in (or its plan's usage is known); Codex once its usage is known. Its plan and usage when known. Never
   * OpenCode: its CLI needs no sign-in, so its presence says nothing about anyone's account (`brains.opencode` and
   * `canAdd` say where its free tier can think, ADR 0132 §6).
   */
  own: Partial<Record<AccountKind, OwnSignIn>>;
}

/** A computer's own sign-in as the AI accounts page lists it. */
export interface OwnSignIn {
  /** The plan the CLI reported (`max`, `pro`…); absent when it didn't say. */
  plan?: string;
  usage?: PlanUsage;
}

export interface AiAccountsView {
  /** The caller's own accounts, on every computer, each with where it is. */
  accounts: (MachineAccountView & { machineId: string; computer: string })[];
  computers: AiComputer[];
}

/** `GET …/ai-accounts` (any member): the caller's plans and keys on the computers, and where they can add one. */
export async function listAiAccounts(deps: BrainDeps, userId: string, orgId: string): Promise<AiAccountsView> {
  await requirePermission(deps.db, userId, orgId, "read");
  const rows = await deps.db
    .select()
    .from(schema.machines)
    .where(and(eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)))
    .orderBy(schema.machines.createdAt);
  const accounts = await Promise.all(
    rows.map(async (m) =>
      (await listMachineAccounts(deps, orgId, m.id, userId))
        .filter((a) => a.mine)
        .map((a) => ({ ...a, machineId: m.id, computer: m.name })),
    ),
  );
  return {
    accounts: accounts.flat(),
    computers: rows.map((m) => {
      const options = brainOptions(m);
      const can = (kind: BrainKind) => options.some((o) => o.kind === kind && o.available);
      return {
        machineId: m.id,
        name: m.name,
        online: machineOnline(m),
        mine: m.pairedByUserId === userId,
        canAdd: mayAddAccounts(m, userId) && m.protocol >= ACCOUNTS_PROTOCOL,
        keys: m.protocol >= PLAN_KEYS_PROTOCOL,
        shares: {
          claude_code: sharesSignIns(m, "claude_code"),
          codex: sharesSignIns(m, "codex"),
          cursor: sharesSignIns(m, "cursor"),
          opencode: sharesSignIns(m, "opencode"),
          grok: sharesSignIns(m, "grok"),
          antigravity: sharesSignIns(m, "antigravity"),
          key: sharesSignIns(m, "key"),
        },
        off: Object.fromEntries(options.flatMap((o) => (o.reason ? [[o.kind, o.reason]] : []))),
        brains: {
          claude_code: can("claude_code"),
          codex: can("codex"),
          cursor: can("cursor"),
          opencode: can("opencode"),
          grok: can("grok"),
          antigravity: can("antigravity"),
        },
        own: m.pairedByUserId === userId ? ownSignIns(m.executors, can) : {},
      };
    }),
  };
}

/** The CLIs' own sign-ins a computer reported (see `AiComputer.own`). */
function ownSignIns(
  executors: schema.MachineExecutors | null | undefined,
  can: (kind: BrainKind) => boolean,
): Partial<Record<AccountKind, OwnSignIn>> {
  const usage: OwnPlanUsage = executors?.ownUsage ?? {};
  const out: Partial<Record<AccountKind, OwnSignIn>> = {};
  const claude = executors?.claude;
  // A usage read stays after a sign-out (`ownUsage` is never cleared): `claude auth status` saying signed out wins,
  // as it does for the turns (`claudeCodeAvailability`).
  if (can("claude_code") && (claude?.loggedIn === true || (claude?.loggedIn !== false && usage.claude_code)))
    out.claude_code = {
      ...(claude?.plan ? { plan: claude.plan } : {}),
      ...(usage.claude_code ? { usage: usage.claude_code } : {}),
    };
  if (can("codex") && usage.codex) out.codex = { usage: usage.codex };
  return out;
}
