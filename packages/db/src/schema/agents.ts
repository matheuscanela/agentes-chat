import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { machineAccounts, machines } from "./machines";
import { organizationMembers, organizations } from "./tenancy";

/**
 * API keys of model providers, owned by the organization (BYOK). Never
 * returned to any client. Envelope encryption (docs/adr/0007-provider-credentials.md):
 * the secret is encrypted with a random per-credential data key (AES-256-GCM),
 * and the data key is wrapped by the key-encryption key named in `kekId`
 * (self-host: derived from AGENTES_SECRET; Cloud: a KMS key, via the
 * `KeyWrapper` adapter). Both ciphertexts are bound to (org_id, id).
 */
/** A workspace's own model endpoint as its credential keeps it (ADR 0146). Prices in nano-USD per token. */
export interface StoredEndpoint {
  style: "openai" | "openai-responses" | "anthropic";
  baseURL: string;
  models: {
    id: string;
    label?: string;
    prices?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    /** The last test call: answered and called a tool, answered without calling it, or failed. */
    check?: "ok" | "no_tools" | "failed";
  }[];
}

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Provider id from `PROVIDERS` in `@agenteschat/providers` (text, so new providers need no migration). */
    provider: text().notNull(),
    label: text().notNull(),
    /** `v1.<iv>.<ciphertext>.<tag>` of the API key, under the data key. */
    secretCiphertext: text().notNull(),
    /** The data key, wrapped by the key-encryption key. */
    wrappedDataKey: text().notNull(),
    /** Which key-encryption key wrapped the data key, e.g. `local:v1`. Enables rotation. */
    kekId: text().notNull(),
    /**
     * Provider account scoping sent with every call, e.g. Anthropic's
     * `anthropic-workspace-id` for keys not scoped to a workspace. Not secret.
     */
    workspaceId: text(),
    /**
     * Other provider options sent with calls, e.g. OpenAI `{ organization, project }`, or a workspace endpoint's
     * address, API style and models (`custom`, ADR 0146). Not secret.
     */
    options: jsonb()
      .$type<{ organization?: string; project?: string; endpoint?: StoredEndpoint }>()
      .notNull()
      .default({}),
    /** Last 4 characters of the key, so people can tell keys apart. */
    keyHint: text().notNull(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * A named group of the workspace's agents, shared by everyone in it (ADR 0083): the sidebar's sections. Shown as a
 * setor (department, ADR 0148) with its color, icon, the person who leads it and their substitute.
 * An agent is in at most one (`agents.group_id`).
 */
export const agentGroups = pgTable(
  "agent_groups",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Order among the workspace's groups. */
    position: integer().notNull().default(0),
    /** One of the roles' colors (`ROLE_COLORS`: the agents' colors but sky). */
    color: text().notNull().default("graphite"),
    /** One of the roles' icons (`ROLE_ICONS`). */
    icon: text().notNull().default("person"),
    /** Who leads the setor: its agents with no owner of their own report to them on the org chart. */
    leadUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Who covers for the lead. */
    backupUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.position)],
);

/**
 * An AI agent: a member of the organization that is not a person. Agents are
 * not Better Auth users; messages have a polymorphic author instead.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Lower-case handle used in @mentions, unique per organization. */
    handle: text().notNull(),
    /**
     * Handles it had before a rename, oldest first: what names one (a mention, a tool's input, an old message)
     * still reaches it (`currentHandles` in packages/engine/src/agents.ts), and no one else may take one. Checked
     * in code, not by a constraint. Emptied when it is deleted, so they are free again.
     */
    previousHandles: text().array().notNull().default(sql`'{}'::text[]`),
    /** Short job title, e.g. "Developer" or "Support". */
    role: text().notNull().default(""),
    /** Standing instructions, part of the system prompt. */
    instructions: text().notNull().default(""),
    /** Model id from the catalog in `@agenteschat/providers`. */
    model: text().notNull(),
    /**
     * Provider credential this agent bills to. Null = the platform key, which
     * only exists when a module (Cloud) provides one; otherwise calls fail.
     */
    credentialId: uuid().references(() => providerCredentials.id, { onDelete: "set null" }),
    /** Person accountable for this agent (receives approvals, budget alerts). */
    ownerUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Spend cap per calendar month (UTC) in nano-USD (1e-9 USD). Null = the organization's default (`organization_settings.default_agent_budget_nano_usd`). */
    monthlyBudgetNanoUsd: bigint({ mode: "number" }),
    /**
     * Who can talk to it: `everyone`, `people` (`audience_user_ids`, anyone holding one of `audience_role_ids`
     * at the time, plus the owner) or `owner`. Enforced wherever a person's message can start a run; nothing else
     * is restricted (it still reads the channel).
     */
    audienceMode: text().$type<"everyone" | "people" | "owner">().notNull().default("everyone"),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * Other agents may consult it for a person outside its audience (ADR 0085 addendum): it answers the agent that
     * asked, never that person. A plan only answering its owner (ADR 0059 §5) still keeps them out.
     */
    consultable: boolean().notNull().default(true),
    /**
     * Autonomy brakes (ADR 0131): what it may start that nobody asked for directly (costly work, how much at once,
     * PRs an hour) and which agents it may call. Validated in code (`autonomySettings`); `{}` = the defaults.
     */
    autonomyBrakes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * "Pode fazer merge sem perguntar": the repositories (`owner/name`) it merges in with no approval card, each merge
     * audited and with a receipt. Its owner or an admin sets it; every other sensitive kind still asks.
     */
    mergeRepos: jsonb().$type<string[]>().notNull().default([]),
    /** Its look in the app (color, eyes, accessory from a fixed allow-list). Null = the default look. */
    appearance: jsonb().$type<{ color: string; eyes: string; accessory: string }>(),
    /**
     * The setup checklist at the top of its chat (ADR 0155 §2): the ready-made role it started from (null: from
     * scratch or made elsewhere) and the steps a person confirmed. Null = made before the checklist: none shows.
     * No migration for its extras (jsonb).
     */
    setup: jsonb().$type<{
      role: string | null;
      done: string[];
      /** ADR 0164: how it introduced itself on its card, its personal starter, its apps at their levels. */
      hello?: string;
      starter?: string;
      apps?: Record<string, "read" | "write">;
    }>(),
    /**
     * Its computer (ADR 0025): the connected machine it works on; null = none yet (the workspace's own computer
     * takes the agents with none once it connects).
     */
    machineId: uuid(),
    /**
     * The autonomy its new missions start with (`always | low_risk_auto |
     * never`, validated in code; "Usar como padrão"). Null = `low_risk_auto`.
     */
    missionCommandApproval: text(),
    /**
     * How much it asks before acting (ADR 0173): `always` (before every change), `risky` (what is marked sensitive,
     * the default) or `never` (nothing, merge, deploy and routines included). Validated in code
     * (`APPROVALS_LEVELS`). It never widens what the agent may use.
     */
    approvalsLevel: text().$type<"always" | "risky" | "never">().notNull().default("risky"),
    /**
     * Who thinks for it (ADR 0032): `model` (the API, default), `claude_code`
     * or `codex` on its computer; validated in code (`brain-settings.ts`).
     */
    brain: text().notNull().default("model"),
    /** The computer brain's model (`opus`, `sonnet`, `haiku`, a Codex model); null = the brain's default. */
    brainModel: text(),
    /** When the computer brain can't answer, answer through the API (counts against the budget). */
    brainFallback: boolean().notNull().default(true),
    /**
     * Long work may go on into the plan's paid extra usage, where the provider reports it on (ADR 0118); off, it
     * pauses at 95% of the plan like any other.
     */
    brainExtraUsage: boolean().notNull().default(true),
    /**
     * The account its computer brain runs with (ADR 0041), on its machine and
     * of its brain's kind (checked in code); null = the computer's own sign-in.
     * Cleared when the agent changes computer or brain kind, or the account goes.
     * An account the runner doesn't say thinks for all of its owner's agents
     * (`machine_accounts.shared`) thinks for one at most (ADR 0059 §2, checked
     * in code under a lock on the account's row).
     */
    brainAccountId: uuid(),
    /**
     * Who gave it `brainAccountId` though that plan isn't theirs and isn't the agent's owner's (`use_others_plans`,
     * ADR 0059 §3 amended 2026-11-04): such a plan thinks for it while this is set, and its owner may take it back.
     * Set whenever the account changes (`setAgentBrain`), only read together with `brainAccountId`. No foreign key:
     * the plan stays lent if that person leaves.
     */
    brainAccountLentBy: text(),
    /** How hard its computer brain thinks (`low`…`max`, ADR 0041); null = the CLI's default. */
    brainEffort: text(),
    /**
     * How fast it answers in conversations (`standard`, `fast`, ADR 0149). Kept when its model or sign-in stops
     * supporting it, where it just doesn't apply. The right hand has none.
     */
    brainSpeed: text().notNull().default("standard"),
    /**
     * It may follow a light reply with a sticker or a GIF of its own (ADR 0091), as often as the workspace's
     * `organization_settings.agent_media` allows. Off: never.
     */
    mediaReplies: boolean().notNull().default(true),
    /**
     * The most context its model reads, in tokens (`200000`, `400000`, `1000000`; validated in code): the API
     * brain compacts past it, Claude Code and Codex compact there too. Null = the model's own window.
     */
    contextTokens: integer(),
    /** Sites its browser may open (ADR 0040, `*.example.com` matches the domain too); null = any site. */
    browserAllowedDomains: text().array(),
    /**
     * The connected computer its browser last ran on (ADR 0040): a mission's
     * or its own. The live view, take over and Stop follow it.
     */
    browserMachineId: uuid(),
    /** Its default browser (ADR 0110): a profile it is granted; null = its own browser. */
    browserProfileId: uuid(),
    /**
     * Held by the people who run this server (operator API, ADR 0056): it starts nothing, the rest of the
     * workspace works (`standing.ts`). The reason is theirs: the workspace only reads that it is paused.
     */
    operatorHoldAt: timestamp({ withTimezone: true }),
    operatorHoldReason: text(),
    /** Its group in the sidebar (ADR 0083); null = none. Deleting the group sets it back to null. */
    groupId: uuid().references(() => agentGroups.id, { onDelete: "set null" }),
    /** Order inside its group. */
    groupPosition: integer().notNull().default(0),
    /**
     * "Responde a" (ADR 0148 addendum): the agent it reports to, in the same workspace (checked in code, as the right
     * hand, loops and depth are). It says where its news goes by default and who it may always call; it grants nothing.
     * Null: its owner, else its setor's lead.
     */
    reportsToAgentId: uuid().references((): AnyPgColumn => agents.id, { onDelete: "set null" }),
    /**
     * A built-in agent the product ships (ADR 0137): `right_hand` is the team's right hand, one per workspace (the
     * index below), never archived, deleted, exported or imported. Null = an agent people made.
     */
    builtin: text().$type<"right_hand">(),
    /**
     * The right hand on a person's plan (ADR 0137 §1, amended 2026-11-04): "Atende outras pessoas", whether other
     * people's DMs with it think with that plan too. Off: only the plan's owner's. Read for the right hand only (every
     * other agent's is its audience, ADR 0059 §5).
     */
    planForOthers: boolean().notNull().default(false),
    /**
     * Retired with ADR 0093 (superseded by ADR 0137): nothing reads or writes it. Kept, with its index, while a
     * running version still selects it (`check:migrations`); dropped by a migration in a later release.
     */
    coordinator: boolean().notNull().default(false),
    /**
     * What it says it is doing (`set_status`, ADR 0084): a line, an optional emoji, and whether it asks not
     * to be interrupted. Tied to the run that wrote it (gone once that run ends) unless it set an end time.
     */
    statusText: text(),
    statusEmoji: text(),
    statusBusy: boolean().notNull().default(false),
    statusRunId: uuid(),
    statusUntil: timestamp({ withTimezone: true }),
    /**
     * Who wrote the line: `self` (the agent's own words, `status_text`) or `auto` (picked for the run from what it
     * works on, `status_kind` + `status_subject`, worded by the apps). `status_at`: when it last changed.
     */
    statusSource: text().$type<"self" | "auto">(),
    statusKind: text(),
    statusSubject: text(),
    statusAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
    /**
     * Deleted for good (ADR 0082): a tombstone, archived too, keeping only its name, role and look for what it
     * left behind (messages, usage, audit). Its handle becomes `deleted-<id>`, longer than any handle people
     * pick, so the old one is free again.
     */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.handle),
    unique().on(t.orgId, t.id),
    uniqueIndex("agents_one_coordinator").on(t.orgId).where(sql`${t.coordinator} and ${t.archivedAt} is null`),
    uniqueIndex("agents_one_right_hand").on(t.orgId).where(sql`${t.builtin} = 'right_hand'`),
    // Machines are only soft-deleted (and `deleteMachine` clears this column first).
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }),
    // No action (a composite SET NULL would null `org_id` too): code clears it before an account row goes.
    foreignKey({
      columns: [t.orgId, t.brainAccountId],
      foreignColumns: [machineAccounts.orgId, machineAccounts.id],
    }),
  ],
);

/**
 * Organization-wide settings that reference other tables (kept out of
 * `organizations` to avoid a schema import cycle). One row per organization,
 * created on first write.
 */
export const organizationSettings = pgTable("organization_settings", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * Credential that pays for calls made for the organization rather than an
   * agent: router, summaries. Null = newest active credential of the provider,
   * then the platform key (Cloud).
   */
  defaultCredentialId: uuid().references(() => providerCredentials.id, { onDelete: "set null" }),
  /** The default key per provider (`{ anthropic: id, openai: id }`); wins over `default_credential_id`. */
  defaultCredentialIds: jsonb().$type<Partial<Record<string, string>>>().notNull().default({}),
  /** Router model for this organization (catalog id). Null = `ROUTER_MODEL` of the deployment. */
  routerModel: text(),
  /** Model that writes thread/period summaries. Null = `SUMMARY_MODEL` of the deployment. */
  summaryModel: text(),
  /** IANA time zone used as the default for routines, e.g. `America/Sao_Paulo`. */
  timezone: text().notNull().default("UTC"),
  /** From onboarding: `solo`, `small`, `medium` or `large`. */
  teamSize: text(),
  /**
   * Monthly budget of every agent without one of its own (`agents.monthly_budget_nano_usd`
   * null), in nano-USD. Set by admins; members only ever see percentages.
   */
  defaultAgentBudgetNanoUsd: bigint({ mode: "number" }).notNull().default(50_000_000_000),
  /**
   * Monthly AI limits per person (ADR 0141), in nano-USD: `{ default?, roles?: { [roleId]: n | null },
   * people?: { [userId]: n | null }, onLimit?: "block" | "notify", warn?: boolean }`; null means no limit. Read
   * through `personLimitsOf` (packages/engine/src/person-usage.ts). Empty: nobody has a limit.
   */
  personLimits: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  /** Agents check what the team already did before an outside action (ADR 0064). On unless an admin turns it off. */
  actionCheck: boolean().notNull().default(true),
  /**
   * The models "Automático" picks per tier on a provider's key where the workspace chose its own
   * (`{ openrouter: { small, medium, large } }`); a tier left out is the provider's default (ADR 0087).
   */
  autoModels: jsonb().$type<Partial<Record<string, Partial<Record<string, string>>>>>().notNull().default({}),
  /** People can send GIFs in chat (ADR 0091): needs the server's `GIPHY_API_KEY` too. */
  gifs: boolean().notNull().default(true),
  /** The most a GIF may be rated: `g` (any age) or `pg` (ADR 0091). */
  gifRating: text().$type<"g" | "pg">().notNull().default("g"),
  /** The agents' own stickers, drawn from each agent's look (ADR 0091). */
  agentStickers: boolean().notNull().default(true),
  /** How often agents follow a light reply with a sticker or a GIF: `never`, `sometimes` or `often` (ADR 0091). */
  agentMedia: text().$type<"never" | "sometimes" | "often">().notNull().default("sometimes"),
  /** What a new agent starts thinking with, and its Autonomia (ADR 0094); null = "Automático" on the API. */
  agentSetup: jsonb().$type<AgentSetup>(),
  /** People can send voice messages (ADR 0100): needs a speech engine on the server too. */
  voiceMessages: boolean().notNull().default(true),
  /**
   * "Agentes melhoram as skills sozinhos": an agent's fix to a skill a person made applies at once (a new version,
   * with Desfazer) instead of waiting as a proposal; scripts still wait for a person (ADR 0120). A skill's own
   * `skills.agents_improve` wins.
   */
  agentsImproveSkills: boolean().notNull().default(true),
  /**
   * Who the workspace is for (ADR 0159): `team` or `personal`. It changes defaults, words and what is in sight, never
   * what exists or who may do what.
   */
  mode: text().$type<"team" | "personal">().notNull().default("team"),
  /**
   * Agents' commits end with their own `Co-authored-by: <name> <noreply@agentes.chat>` (ADR 0156). On unless a person
   * asks an agent to turn it off (`commit_co_author`); no screen has it.
   */
  agentCoAuthor: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * An agent's "Quem pensa" and its Autonomia as a value (ADR 0094): the last one someone saved, or used on other
 * agents, is what new agents start with. Validated in code (`agent-setup.ts`).
 */
export interface AgentSetup {
  brain: "model" | "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
  /** The API brain: the agent's model (`auto` included). A computer brain: its model as stored (null: the default). */
  model: string | null;
  /** The API brain's key (null: the workspace's default). */
  key?: string | null;
  /** A computer brain: the computer it thinks on, and its account there (null: that computer's own sign-in). */
  machineId?: string | null;
  account?: string | null;
  effort?: string | null;
  contextTokens?: number | null;
  fallback?: boolean;
  /** Its Autonomia (`agents.mission_command_approval`); null: the default. */
  autonomy?: string | null;
}

/**
 * Each person's own AI for the team's right hand (ADR 0137 §11): the plan their DM with it thinks with, theirs or one
 * shared with them. No row: their DM thinks with the workspace's (the right hand's own `agents` row). It goes with the
 * person's membership and with the account.
 */
export const rightHandBrains = pgTable(
  "right_hand_brains",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    /** A computer brain (`claude_code`, `codex`…): an API key is the workspace's, never a person's. */
    brain: text().notNull(),
    brainModel: text(),
    brainAccountId: uuid().notNull(),
    /** Someone else's plan, given with `use_others_plans`: who gave it (themselves); its owner may take it back. */
    brainAccountLentBy: text().references(() => users.id, { onDelete: "set null" }),
    brainEffort: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.brainAccountId],
      foreignColumns: [machineAccounts.orgId, machineAccounts.id],
    }).onDelete("cascade"),
    index().on(t.orgId, t.brainAccountId),
  ],
);
