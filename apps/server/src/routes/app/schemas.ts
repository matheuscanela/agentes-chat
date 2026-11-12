import { ACCOUNT_KINDS, BRAIN_EFFORTS, BRAIN_SPEEDS } from "@agenteschat/adapters";
import {
  AGENT_ACTION_KINDS,
  AGENT_STYLES,
  CHAT_OPEN_AT,
  CHAT_STYLES,
  CHAT_TEXT_SIZES,
  CHAT_TONES,
  ONBOARDING_STEPS,
  STANDING_STATES,
  START_PAGES,
  WORKSPACE_MODES,
} from "@agenteschat/engine";
import { CONTEXT_LIMITS, ENDPOINT_STYLES, MODEL_TIERS, PROVIDER_IDS } from "@agenteschat/providers";
import { z } from "@hono/zod-openapi";

/** Who a task or a wiki page is for (ADR 0151): "only me" is a list of one. Administrators always see it. */
export const AudienceChoice = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("everyone") }),
    z.object({ mode: z.literal("people"), userIds: z.array(z.string().min(1).max(200)).max(200) }),
  ])
  .openapi("AudienceChoice");

/** A last message that was only a GIF or a sticker (ADR 0091): the apps say which, translated, in its preview. */
export const MediaKind = z.enum(["gif", "sticker", "voice"]).nullable().openapi({
  description:
    "A voice message (ADR 0100), whose preview has no text, or a message of only a GIF or a sticker (ADR 0091): show `GIF` or `Sticker` in the reader's language where its text would be. Null for a message with text.",
});

/** A last-message preview's `meta`: what the app needs to show a server-written body in the reader's language. */
export const PreviewMeta = z.record(z.string(), z.unknown()).nullable().openapi({
  description:
    "For a body the server wrote (`bodyCode` + `bodyParams`, a cut-off run's notes, memory lines): show it in the reader's language, like the message itself. `media`: the message's GIF or sticker (ADR 0091), as `meta.media`, for a preview with no text. Null for a plain message.",
});

export const Role = z.enum(["owner", "member"]).openapi("Role", {
  description:
    "Whether the person owns the workspace (ADR 0085). What a member may do comes from their roles (`roleIds`, `GET …/roles`) and is sent resolved as `permissions`.",
});

/** One person's resolved permissions in a workspace (ADR 0085): the apps hide what's not there. */
const Permissions = z.array(z.string()).openapi({
  description:
    "Everything this person may do here: their roles' keys and `everyone`'s, every key with `administrator`, all of them for an owner, plus `read` (any member) and `manage_owners` (owners).",
});
const Rank = z.number().int().nullable().openapi({
  description: "Their highest role's position (0 the top), null with none. They manage roles and people below it.",
});
const RoleIds = z.array(z.string()).openapi({ description: "Their roles (`org_roles` ids), not `everyone`." });

export const ProviderId = z.enum(PROVIDER_IDS).openapi("ProviderId");

export const ModelTier = z.enum(MODEL_TIERS as ["small", "medium", "large"]);

export const StartChoice = z
  .object({
    page: z.enum(START_PAGES),
    channelId: z.uuid().nullable().openapi({ description: "With `channel`, else null." }),
  })
  .openapi("StartChoice", {
    description:
      "What opens when the app starts here (ADR 0108): `home` (Início, Conversas on the phone), `last` (where the person was, kept on each device) or `channel` (open the home when they are no longer in it).",
  });

export const ChatPrefs = z
  .object({
    channelStyle: z.enum(CHAT_STYLES).optional(),
    dmStyle: z.enum(CHAT_STYLES).optional(),
    channelTone: z.enum(CHAT_TONES).optional(),
    dmTone: z.enum(CHAT_TONES).optional(),
    openAt: z.enum(CHAT_OPEN_AT).optional(),
    textSize: z
      .enum(CHAT_TEXT_SIZES)
      .optional()
      .openapi({ description: "Tamanho do texto of the messages, smallest first; absent: `md`." }),
    feedbackAuto: z.boolean().optional().openapi({
      description:
        "Always send: a report an agent offers about the app goes with its reply, without asking; absent: it asks.",
    }),
  })
  .openapi("ChatPrefs");

export const Organization = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: Role,
    permissions: Permissions,
    rank: Rank,
    context: z
      .string()
      .optional()
      .openapi({ description: "What the agents know of it: only for who may `configure`." }),
    logo: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "The workspace logo (`/api/app/org-logos/…`); null = the agent mark." }),
    createdAt: z
      .string()
      .optional()
      .openapi({ description: "In `GET /me`: when it was made, which tells apart two workspaces with the same name." }),
    standing: z
      .object({
        state: z.enum(STANDING_STATES),
        reason: z.string().nullable().openapi({ description: "Only when the workspace is told why; else null." }),
        cloud: z.literal(true).optional().openapi({
          description:
            "agentes.chat Cloud: the apps read `review` as the automatic review hold's line (`review.<category>` naming what was flagged), and add how to contest a reason.",
        }),
      })
      .optional()
      .openapi({ description: "In `GET /me` (ADR 0056 §8). Changes come as `org.standing` org events." }),
    onboarding: z
      .object({
        step: z.enum(ONBOARDING_STEPS).openapi({ description: "The furthest step reached: where it resumes." }),
        generalChannelId: z
          .uuid()
          .openapi({ description: "#general, where the onboarding puts the agents and posts the first message." }),
      })
      .optional()
      .openapi({
        description:
          "In `GET /me`, to its owner only, while the workspace's onboarding isn't finished: the apps open the onboarding, which resumes it, instead of the workspace (`PATCH …/onboarding` saves it). Absent: finished, or not theirs to set up.",
      }),
    deletion: z
      .object({
        dueAt: z.string().nullable().openapi({
          description: "When it goes for good; null once that date passed, when it is only being deleted.",
        }),
        requestedAt: z.string().nullable(),
        requestedBy: z
          .object({ id: z.string(), name: z.string() })
          .nullable()
          .openapi({ description: "Who deleted it; null once their account is gone." }),
      })
      .optional()
      .openapi({
        description:
          "In `GET /me`, while an owner's deletion is pending: the workspace is read-only (its changes answer `org.deleting`), and any owner can restore it until `dueAt` (`DELETE …/deletion`). Absent: not being deleted.",
      }),
    start: StartChoice.optional().openapi({
      description: "In `GET /me`: what opens when the app starts here (`PUT …/me/start`). Absent elsewhere.",
    }),
    showActivity: z.boolean().optional().openapi({
      description:
        "In `GET /me`: whether you see what agents did under each reply (`PUT …/me/activity`), off by default. Absent elsewhere.",
    }),
    agentStyle: z.enum(AGENT_STYLES).nullable().optional().openapi({
      description:
        "In `GET /me`: how agents talk to you here (`PUT …/me/agent-style`, ADR 0147): `simple` or `technical`; null until you pick, and agents talk simply. Absent elsewhere.",
    }),
    chatPrefs: ChatPrefs.optional().openapi({
      description:
        "In `GET /me`: how conversations look to you here (`PUT …/me/chat`). Only what you chose: a key not here keeps the app's default. Absent elsewhere.",
    }),
    mode: z.enum(WORKSPACE_MODES).optional().openapi({
      description:
        "Who the workspace is for (ADR 0159): `team` or `personal`. It changes the apps' defaults and words, never what anyone may do. Changed with `PATCH …/settings`.",
    }),
  })
  .openapi("Organization");

export const Member = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    avatarUrl: z.string().nullable().openapi({ description: "The photo uploaded here; wins over `image`." }),
    role: Role,
    roleIds: RoleIds,
    joinedAt: z.string(),
    handle: z.string(),
    timezone: z.string(),
  })
  .openapi("Member");

export const Invitation = z
  .object({ id: z.uuid(), email: z.string(), role: Role, roleIds: RoleIds, expiresAt: z.string() })
  .openapi("Invitation");

/** Per million tokens, in US dollars, as people type prices. */
export const EndpointPrices = z
  .object({
    input: z.number().min(0).max(10_000),
    output: z.number().min(0).max(10_000),
    cacheRead: z.number().min(0).max(10_000).optional().openapi({ description: "Absent: the input price." }),
    cacheWrite: z.number().min(0).max(10_000).optional().openapi({ description: "Absent: the input price." }),
  })
  .openapi("EndpointPrices");

export const EndpointModel = z
  .object({
    id: z.string().min(1).max(200).openapi({ description: "The id the endpoint takes." }),
    label: z.string().max(120).optional(),
    prices: EndpointPrices.optional().openapi({
      description: "Absent: unpriced. Its calls are recorded with their tokens and cost 0, so no budget limits them.",
    }),
    check: z
      .enum(["ok", "no_tools", "failed"])
      .optional()
      .openapi({ description: "The last test call: it called a tool, answered without one, or failed." }),
  })
  .openapi("EndpointModel");

export const EndpointStyle = z.enum(ENDPOINT_STYLES).openapi("EndpointStyle", {
  description: "The API the endpoint speaks: OpenAI's Chat Completions, OpenAI's Responses or Anthropic's Messages.",
});

export const EndpointCheck = z
  .object({
    model: z.string(),
    check: z.enum(["ok", "no_tools", "failed"]),
    error: z.string().optional().openapi({ description: "The server's words, when it failed." }),
  })
  .openapi("EndpointCheck");

export const Credential = z
  .object({
    id: z.uuid(),
    provider: ProviderId,
    label: z.string(),
    endpoint: z
      .object({ style: EndpointStyle, baseURL: z.string(), models: z.array(EndpointModel) })
      .optional()
      .openapi({ description: "A workspace's own endpoint (`custom`, ADR 0146): its address, API and models." }),
    keyHint: z.string().openapi({ description: "Last 4 characters of the key. The key itself is never returned." }),
    workspaceIdHint: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "Last characters of the workspace the key is scoped to, if set." }),
    isDefault: z
      .boolean()
      .optional()
      .openapi({ description: "The workspace's default key (agents without their own key, router, summaries)." }),
    usedBy: z
      .array(z.object({ id: z.uuid(), name: z.string() }))
      .optional()
      .openapi({ description: "The agents that think with it, in a list of keys: what removing it would change." }),
    check: z
      .enum(["ok", "unchecked"])
      .optional()
      .openapi({ description: "On a key just saved: `ok` a real call passed, `unchecked` the provider didn't say." }),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .openapi("Credential");

/**
 * Who can talk to an agent. `userIds` and `roleIds` for `people` (under `owner`: the ones a plan kept out); the owner
 * always can. A role lets in whoever holds it at the time; `everyone` isn't one to pick (that's `mode: everyone`).
 */
export const AgentAudience = z
  .object({
    mode: z.enum(["everyone", "people", "owner"]),
    userIds: z.array(z.string()).max(500),
    roleIds: z
      .array(z.uuid())
      .max(100)
      .optional()
      .openapi({ description: "Absent (older apps): a change keeps the roles already picked." }),
    consultable: z.boolean().optional().openapi({
      description:
        "Other agents may consult it for people outside this audience; it answers them, never those people. On by default; absent = keep. A plan answering only its owner (ADR 0059 §5) still keeps them out.",
    }),
  })
  .openapi("AgentAudience");

/** How much an agent asks before acting (ADR 0173). */
export const ApprovalsLevel = z.enum(["always", "risky", "never"]).openapi("ApprovalsLevel", {
  description:
    "`always`: every write to a connected app asks a person. `risky` (the default): what is marked sensitive asks. `never`: only merge, deploy, rollback and the like ask. A routine's run, and one a routine's reading feeds, ask for every write to a connected app at any level. Scopes, connector access and the budget bind at every level.",
});

/** An agent's autonomy brakes (ADR 0131): what it may start that nobody asked for directly, and whom it may call. */
export const AgentBrakes = z
  .object({
    costly: z.enum(["ask", "go"]).openapi({
      description:
        "Costly work nobody asked for directly (opening a PR, installing packages, a long job): `ask` proposes it to a person first, `go` does it.",
    }),
    go: z.array(z.enum(["pr", "install", "long"])).openapi({ description: "Kinds a person said always to." }),
    never: z.array(z.enum(["pr", "install", "long"])).openapi({ description: "Kinds a person said never to." }),
    maxUnrequested: z.number().int().min(1).max(20).openapi({ description: "Unrequested jobs it may run at once." }),
    maxPrsPerHour: z
      .number()
      .int()
      .min(0)
      .max(50)
      .openapi({ description: "PRs its unrequested work may open in an hour." }),
    callAgents: z.enum(["all", "some", "none"]).openapi({ description: "Which agents it may wake or hand work to." }),
    callAgentIds: z.array(z.uuid()).max(200).openapi({ description: "With `some`: those agents." }),
    project: z.string().max(80).openapi({
      description: "Its project (a repository, a product): agents of different projects don't call each other.",
    }),
    otherProjects: z.boolean().openapi({ description: "It may call agents of other projects too." }),
  })
  .openapi("AgentBrakes");

export const AgentAppearance = z
  .object({
    color: z.union([
      z.enum(["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"]),
      z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .openapi({ description: 'A custom color ("Personalizar"), stored lowercase.' }),
    ]),
    eyes: z.enum(["round", "dots", "wide", "happy", "sleepy"]),
    accessory: z.enum([
      "none",
      "hat",
      "cap",
      "headphones",
      "bow",
      "crown",
      "antenna",
      "headset",
      "beanie",
      "party",
      "flower",
      "scarf",
    ]),
  })
  .openapi("AgentAppearance");

export const PlanWindow = z.object({
  kind: z.enum(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "monthly", "other"]),
  label: z.string().optional().openapi({ description: "`other`: the provider's name for it." }),
  usedPercent: z.number().openapi({ description: "0–100." }),
  resetsAt: z.string().optional(),
});

export const PlanUsage = z
  .object({
    windows: z.array(PlanWindow),
    limited: z.boolean().optional().openapi({ description: "The plan refused a request for its limit." }),
    source: z.enum(["turn", "probe"]),
    at: z.string().openapi({ description: "When the computer learned it." }),
    models: z
      .record(
        z.string(),
        z.object({
          at: z.string(),
          until: z.string().optional(),
          region: z.literal(true).optional(),
          off: z.literal(true).optional(),
          inactive: z.literal(true).optional(),
        }),
      )
      .optional()
      .openapi({
        description:
          "Models at a limit of their own, by model id: until `until` (absent: unknown), `region`: the model needs a region the account doesn't allow, `off`: the plan refused it for the key (the model or the account switched off there), or `inactive`: the key's workspace has no active subscription.",
      }),
  })
  .openapi("PlanUsage", {
    description: "A plan's usage limits, as the CLI on the computer said them (no token is ever read).",
  });

/** An agent no longer in the team (archived or deleted, ADR 0082): what its messages and reports still show. */
export const FormerAgent = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: z.string(),
    appearance: AgentAppearance.nullable(),
    deleted: z.boolean().openapi({ description: "Deleted for good; false: archived (an admin may still delete it)." }),
  })
  .openapi("FormerAgent");

/** The steps of a new agent's setup checklist (ADR 0155 §2). */
export const SetupStep = z.enum(["ai", "apps", "where", "who", "how", "about", "team", "people"]).openapi("SetupStep", {
  description:
    "A new agent's steps (`ai`, `apps`, `where`, `who`, `how`), or the right hand's first run (`about`, `team`, `ai`, `apps`, `people`, ADR 0155 §6), where only `apps` and `people` are stored (skipped).",
});

export const AgentSetupChecklist = z
  .object({
    role: z.string().nullable().openapi({
      description: "The ready-made role it started from (`support`); null: from scratch or made elsewhere.",
    }),
    done: z.array(SetupStep).openapi({ description: "The steps a person confirmed (chose or skipped)." }),
    hello: z.string().optional().openapi({
      description: "How it introduced itself on its card, in its own voice (ADR 0164): its first message says it.",
    }),
    starter: z.string().optional().openapi({ description: "The personal starter it began as (ADR 0159 §3)." }),
    apps: z
      .record(z.string(), z.enum(["read", "write"]))
      .optional()
      .openapi({
        description: "The apps it was made to use (catalog connector ids) at their levels (ADR 0164).",
      }),
  })
  .openapi("AgentSetupChecklist");

export const Agent = z
  .object({
    id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    previousHandles: z.array(z.string()).optional().openapi({
      description:
        "Handles it had before a rename that still reach it (mentions, tools), so an old message's @ shows it (in the agent list and after an edit).",
    }),
    role: z.string(),
    instructions: z.string(),
    model: z.string(),
    ownerUserId: z.string().nullable(),
    hasCredential: z.boolean(),
    monthlyBudgetUsd: z
      .number()
      .nullable()
      .optional()
      .openapi({ description: "Admins only: its own monthly budget; null = the workspace default." }),
    budgetUsedPercent: z
      .number()
      .optional()
      .openapi({ description: "This month's spend over its budget, in % (in the agent list)." }),
    createdAt: z.string(),
    audience: AgentAudience,
    audienceMode: z.enum(["everyone", "people", "owner"]),
    canTalk: z.boolean().openapi({ description: "Whether the current person can talk to it (mentions, DMs)." }),
    seesDetails: z.boolean().openapi({
      description:
        "Whether the current person sees how it works: its owner, who manages agents, and whoever it answers. Without it `instructions` is empty and its tools, memory, usage and activity answer 403 `agent.details_hidden`.",
    }),
    appearance: AgentAppearance.nullable().openapi({ description: "Its look; null = the default." }),
    mediaReplies: z.boolean().openapi({
      description:
        "It may send a sticker or a GIF (ADR 0091): when someone asks for one, and after a light reply as often as the workspace's `agentMedia` allows.",
    }),
    approvalsLevel: ApprovalsLevel,
    builtin: z.enum(["right_hand"]).nullable().openapi({
      description:
        "A built-in agent the product ships (ADR 0137): `right_hand`, the team's right hand, one per workspace, never archived, deleted or exported. Null for the agents people make.",
    }),
    reportsToAgentId: z.uuid().nullable().optional().openapi({
      description:
        "Responde a (ADR 0148 addendum): the agent it reports to. It says where news goes by default and grants nothing; null = its owner, else its setor's lead.",
    }),
    brakes: AgentBrakes,
    setup: AgentSetupChecklist.nullable().openapi({
      description:
        "Its setup checklist at the top of its chat (ADR 0155 §2): the ready-made role it started from and the steps a person confirmed. Null for agents made before it (none shows).",
    }),
    brain: z
      .object({
        kind: z.enum(["model", "claude_code", "codex", "cursor", "opencode", "grok", "antigravity"]),
        model: z
          .string()
          .nullable()
          .openapi({ description: "A computer brain's model label (Sonnet); null = the agent's model." }),
        computer: z.string().optional().openapi({ description: "Its computer's name (admins and the agent's owner)." }),
        provider: z.string().optional().openapi({
          description: "A coding plan it thinks with through Claude Code (`zai`, `kimi`…): its maker's model.",
        }),
        account: z.string().optional().openapi({
          description:
            "On a plan: the account it thinks with (`Claude Team 2`; a computer's own sign-in by its plan, `Claude Max`).",
        }),
        usage: PlanUsage.optional().openapi({
          description: "On a plan: that account's limits as last reported (ADR 0063 §5); absent: not known yet.",
        }),
        speed: z.literal("fast").optional().openapi({
          description: "Set to `fast` where that applies to what it thinks with (ADR 0149); absent: standard speed.",
        }),
        maker: z.string().optional().openapi({
          description:
            "An API brain on Automático: the maker its models come from (its own key's, else the workspace's), whose logo shows beside it.",
        }),
      })
      .optional()
      .openapi({ description: "Who thinks for it (ADR 0032), to show next to its name." }),
  })
  .openapi("Agent");

/** A named group of channels in the sidebar, the same for everyone in the organization. */
export const ChannelCategory = z
  .object({
    id: z.uuid(),
    name: z.string(),
    position: z.number().int().openapi({ description: "Order in the sidebar, from 0." }),
  })
  .openapi("ChannelCategory");

export const Channel = z
  .object({
    id: z.uuid(),
    name: z.string(),
    topic: z.string(),
    visibility: z.enum(["public", "private"]),
    audienceRoleIds: z.array(z.uuid()).optional().openapi({
      description: "Private and limited to these roles (departments, ADR 0125); empty: public or invite only.",
    }),
    isMember: z.boolean(),
    seenAsAdmin: z.boolean().optional().openapi({
      description: "Listed only because you're an administrator (ADR 0151): off the sidebar until opened or joined.",
    }),
    createdByUserId: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "The channel's creator: may manage its members, like admins." }),
    createdAt: z.string(),
    categoryId: z
      .uuid()
      .nullable()
      .optional()
      .openapi({ description: "Its sidebar category; null: on top, with none." }),
    position: z.number().int().optional().openapi({ description: "Order inside its category, from 0." }),
    unreadCount: z.number().int().optional().openapi({
      description:
        "Channel list only: messages since you last read it (since you joined, if never), not yours; a thread reply counts only in a thread you follow; an agent's sticker or GIF after its own reply never (ADR 0091). At most 100; 0 when you're not a member.",
    }),
    mentionCount: z.number().int().optional().openapi({
      description: "Channel list only: of `unreadCount`, the messages that mention you (counted even while muted).",
    }),
    lastReadAt: z.string().nullable().optional().openapi({
      description:
        "Channel list only: where the unread starts (when you last read it, or joined); null when not a member.",
    }),
    can: z.object({ post: z.boolean(), callAgents: z.boolean(), manage: z.boolean() }).optional().openapi({
      description:
        "Channel list only: what you may do here with its exceptions (ADR 0134): send messages, wake its agents, manage it.",
    }),
    muted: z.boolean().optional().openapi({
      description: "Channel list only: you muted it, so it never looks unread (`PUT`/`DELETE …/mute`).",
    }),
    lastMessage: z
      .object({
        id: z.uuid(),
        authorType: z.enum(["person", "agent"]),
        authorId: z.string().nullable(),
        authorName: z.string().nullable().openapi({ description: "Null when the author was deleted." }),
        preview: z.string().openapi({ description: "Plain text, at most 140 characters." }),
        meta: PreviewMeta,
        mediaKind: MediaKind,
        createdAt: z.string(),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "Channel list only: the latest top-level message (an agent's sticker or GIF after its own reply is part of that reply, so the reply shows); null when empty or you're not a member.",
      }),
  })
  .openapi("Channel");

const MessageUsage = z
  .object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number() })
  .openapi("MessageUsage", { description: "Agent messages: model and tokens of the run that wrote it (no money)." });

export const AgentAction = z
  .object({
    id: z.uuid(),
    kind: z
      .enum(AGENT_ACTION_KINDS)
      .openapi({ description: "What the agent did; the app says it with `agentActions.{kind}` and `params`." }),
    agentId: z.uuid(),
    messageId: z.uuid().nullable(),
    requestedByUserId: z
      .string()
      .nullable()
      .openapi({ description: "The person the agent worked for: they, admins and the agent's owner may undo." }),
    target: z.object({
      type: z.enum([
        "issue",
        "memory",
        "routine",
        "channel",
        "wiki_page",
        "thread",
        "skill",
        "agent",
        "repository",
        "role",
        "person",
        "workspace",
      ]),
      id: z.string(),
      number: z.number().optional().openapi({ description: "Issues." }),
      title: z.string().optional().openapi({ description: "Issue, routine, page or thread title; channel name." }),
      slug: z.string().optional().openapi({ description: "Wiki pages." }),
    }),
    params: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          z.array(z.string()),
          z.record(z.string(), z.unknown()),
        ]),
      )
      .openapi({
        description:
          "Values for the sentence (number, title, fields, status, text, agentName…); a routine's `rule` is an object the app words.",
      }),
    createdAt: z.string(),
    undoableUntil: z
      .string()
      .openapi({ description: "Desfazer (or Refazer once undone) works until then; each undo/redo moves it." }),
    undoneAt: z.string().nullable().openapi({ description: "Set while undone." }),
    undoneByUserId: z.string().nullable(),
    redoneAt: z.string().nullable(),
  })
  .openapi("AgentAction", { description: "A change an agent made, shown as a receipt with Undo (ADR 0037)." });

/** A long work's view (ADR 0121): its anchor's line, its card's block, the agent's status. */
export const WorkView = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    title: z.string(),
    status: z.enum(["queued", "live", "done", "failed", "canceled"]),
    state: z
      .enum(["working", "waiting_approval", "waiting_input", "paused", "waiting_computer", "queued"])
      .nullable()
      .openapi({ description: "While live: what its run does now." }),
    how: z.enum(["agent", "auto"]),
    anchorMessageId: z.uuid(),
    threadId: z.uuid().nullable().openapi({ description: "Where its updates are." }),
    homeThreadId: z.uuid().nullable().openapi({ description: "Where it was asked (its report goes there)." }),
    runId: z
      .uuid()
      .nullable()
      .openapi({ description: "Its current run: Parar stops it (`POST …/runs/{runId}/cancel`)." }),
    requestedByUserId: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    nextUpdateAt: z.string().nullable(),
    lastUpdate: z.object({ text: z.string(), at: z.string(), seq: z.number() }).nullable(),
    question: z
      .object({ text: z.string(), messageId: z.uuid().nullable(), requestedForUserId: z.string().nullable() })
      .nullable()
      .openapi({
        description: "Waiting on an answer: what its run asked, the message that holds the card, and who it is for.",
      }),
    plan: z.array(z.object({ id: z.string(), text: z.string(), state: z.enum(["todo", "doing", "done"]) })),
    issue: z.object({ id: z.uuid(), number: z.number() }).nullable(),
    resultMessageId: z.uuid().nullable(),
    queuePosition: z.number().nullable(),
    pausedUntil: z.string().nullable(),
    canceledByUserId: z.string().nullable(),
    errorCode: z.string().nullable(),
  })
  .openapi("WorkView");

const MessageBase = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  threadId: z.uuid().nullable(),
  author: z.object({ type: z.enum(["person", "agent"]), id: z.string().nullable() }),
  body: z.string(),
  mentionedAgentIds: z.array(z.uuid()),
  mentionedUserIds: z.array(z.string()).openapi({ description: "People mentioned by handle who are in the channel." }),
  agentRunId: z.uuid().nullable(),
  clientId: z.string().nullable().openapi({ description: "Echo of the sender's `clientId`." }),
  receipts: z
    .object({
      seenBy: z.array(z.uuid()),
      pickedBy: z.array(z.uuid()),
      handled: z.array(
        z.object({
          agentId: z.uuid(),
          runId: z.uuid(),
          status: z.enum(["queued", "running", "waiting_approval", "waiting_input", "done", "failed", "canceled"]),
          reason: z
            .literal("no_ai")
            .optional()
            .openapi({ description: "It couldn't answer: the agent has no AI connected." }),
          outage: z
            .literal(true)
            .optional()
            .openapi({ description: "`waiting_input` because its AI provider is down: it retries by itself." }),
          computer: z.enum(["queued", "away", "line"]).optional().openapi({
            description:
              "`waiting_input` for its computer: in line for room (`queued`) or for it to come back (`away`); long work in the agent's line of work (`line`).",
          }),
          usage: z.enum(["plan", "budget"]).optional().openapi({
            description: "`waiting_input` on its plan's limit or its budget: it answers when that renews.",
          }),
          passed: z.literal(true).optional().openapi({
            description: "It ended without answering: passed and posted nothing, or canceled before it started.",
          }),
        }),
      ),
      blocked: z
        .array(z.uuid())
        .openapi({ description: "Agents it mentions that won't answer (they don't reply to this person)." }),
      referenced: z
        .array(z.uuid())
        .optional()
        .openapi({ description: "Agents it only references as part of the request to another agent: no run." }),
      noAi: z
        .literal(true)
        .optional()
        .openapi({ description: "Routed to nobody: the organization had no AI connected." }),
      kept: z
        .literal(true)
        .optional()
        .openapi({ description: "With `noAi`: it came in on a billing hold, to be answered after the plan." }),
      platformCap: z.literal(true).optional().openapi({
        description: "Routed to nobody: the workspace used up its platform AI for the month; @mentions still answer.",
      }),
      decidedBy: z
        .union([
          z.object({ step: z.literal("jev") }),
          z.object({ step: z.literal("model"), model: z.string(), provider: z.string() }),
          z.object({ step: z.literal("plan"), brand: z.enum(["claude", "chatgpt"]), ownerId: z.string() }),
          z.object({
            step: z.literal("rule"),
            rule: z.enum(["reply", "only_agent", "follow_up", "coordinator", "default", "alone"]),
          }),
        ])
        .optional()
        .openapi({
          description:
            "Who picked the agents for a message nobody mentioned (ADR 0074): Jev, a small model, the author's own plan (`ownerId`), or a rule (`coordinator` only on decisions from before ADR 0137 retired the team's coordinator). Absent before the chain.",
        }),
      reason: z
        .literal("mention_needed")
        .optional()
        .openapi({ description: "No step could read it and no rule fit: only a mention reaches an agent." }),
    })
    .optional()
    .openapi({ description: "People's messages: agents that saw it, picked it up, and how their runs ended." }),
  meta: z.record(z.string(), z.unknown()).openapi({
    description:
      'Attachments, e.g. `{ approvalId }` on an approval card (see /approvals). `media` (ADR 0091): a GIF `{ kind: "gif", provider, id, title, width, height }` (load it with `GET …/gifs/{id}/media`) or a sticker `{ kind: "sticker", agentId, mood }`, and the body may be empty then. `mediaAfter`: on the sticker or GIF an agent added after its own reply, that reply\'s id.',
  }),
  usage: MessageUsage.optional(),
  reactions: z
    .array(
      z.object({
        reaction: z.string(),
        count: z.number(),
        userIds: z.array(z.string()),
        agentIds: z.array(z.string()),
      }),
    )
    .optional()
    .openapi({
      description:
        "In lists: reactions (`+1`/`-1` or an emoji) and who reacted (people in `userIds`, agents in `agentIds`); live via `message.reactions`.",
    }),
  memories: z
    .array(
      z.object({
        id: z.uuid(),
        agentId: z.uuid(),
        kind: z.enum(["fact", "preference", "decision", "note", "lesson"]),
        text: z.string(),
        createdAt: z.string(),
      }),
    )
    .optional()
    .openapi({
      description:
        "People's messages: what agents saved to memory from them (the memory mark); live via `message.memories`.",
    }),
  pinned: z.boolean().optional().openapi({
    description:
      "In lists: true when pinned in its channel (absent: not pinned); live via `message.pinned`/`message.unpinned`.",
  }),
  actions: z.array(AgentAction).optional().openapi({
    description:
      "Agents' messages in lists: the changes made with this reply, as receipts with Undo; live via `message.actions`.",
  }),
  longWork: WorkView.optional().openapi({
    description: "A long work's anchor (`meta.longWork`, ADR 0121): its line; live via `agent.work`.",
  }),
  createdAt: z.string(),
});

export const Message = MessageBase.extend({
  notices: z
    .array(
      z.object({
        agentId: z.uuid(),
        text: z.string(),
        code: z
          .string()
          .optional()
          .openapi({ description: "`audience.only` / `audience.nobody`: translate with `params`." }),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional()
    .openapi({
      description:
        "Only in the sender's POST response: agents addressed that won't answer this person (who can talk to the agent), with the text to show them.",
    }),
  replies: z
    .object({ count: z.number(), lastAt: z.string().nullable(), latest: z.array(MessageBase) })
    .optional()
    .openapi({ description: "With `include=replies`: the thread's size, last activity and last three replies." }),
}).openapi("Message");

export const Usage = z
  .object({
    agentId: z.uuid(),
    handle: z.string(),
    calls: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
  })
  .openapi("AgentUsage");

export const PlanModelOut = z
  .object({
    id: z.string(),
    label: z.string(),
    alias: z.enum(["opus", "sonnet", "haiku"]).optional(),
    tag: z.enum(["cheap", "fast", "smart"]).optional(),
    needs: z.enum(["globalRegion", "paidTraining", "freeTraining"]).optional(),
    free: z.literal(true).optional(),
    maker: z.string().optional(),
  })
  .openapi("PlanModel");

export const Model = z
  .object({
    id: z.string(),
    label: z.string(),
    provider: z.string(),
    contextWindow: z.number().int().openapi({ description: "Its context window in tokens." }),
    inputUsdPerMTok: z.number(),
    outputUsdPerMTok: z.number(),
    pick: z.boolean().optional().openapi({
      description: "In OpenRouter's long list (ADR 0087): a good pick, shown first. Absent: a catalog model.",
    }),
    tier: ModelTier.optional().openapi({
      description: "The size Automático uses it for on its provider's key, by default.",
    }),
    endpoint: z
      .object({ credentialId: z.uuid(), name: z.string() })
      .optional()
      .openapi({ description: "A workspace endpoint's model (ADR 0146): whose credential, under what name." }),
    unpriced: z
      .boolean()
      .optional()
      .openapi({ description: "No prices known: its calls cost 0, so a budget can't count money for it." }),
  })
  .openapi("Model");

/** ADR 0032: who thinks for an agent. */
export const BrainKind = z
  .enum(["model", "claude_code", "codex", "cursor", "opencode", "grok", "antigravity"])
  .openapi("BrainKind");

export const BrainUnavailable = z.enum([
  "no_computer",
  "exec_off",
  "runner_old",
  "tool_off",
  "not_installed",
  "outdated",
  "not_reported",
  "system",
]);

export const BrainOption = z
  .object({
    kind: BrainKind,
    available: z.boolean(),
    reason: BrainUnavailable.optional().openapi({ description: "Why it can't be chosen now (computer brains)." }),
    models: z.array(
      z.object({
        value: z.string().openapi({ description: "What is stored and passed to the CLI (`opus`, `gpt-…`)." }),
        label: z.string(),
        modelId: z.string().optional().openapi({ description: "The model id behind an alias." }),
        recommended: z.boolean().optional(),
        contextWindow: z
          .number()
          .int()
          .optional()
          .openapi({ description: "Its context window in tokens: the context limits worth offering with it." }),
        inPlan: z
          .boolean()
          .optional()
          .openapi({ description: "Cursor: its CLI said the person's plan includes it (others cost API prices)." }),
        free: z
          .boolean()
          .optional()
          .openapi({ description: "OpenCode: a model of OpenCode's free tier (no key, no cost)." }),
      }),
    ),
    defaultModel: z.string().nullable(),
  })
  .openapi("BrainOption");

export const BrainEffort = z.enum(BRAIN_EFFORTS).openapi("BrainEffort", {
  description: "How hard a computer brain thinks (Claude Code `--effort`; Codex maps `xhigh` and `max` to `high`).",
});

/** The effort setting: a level, or `auto` (picked per run with the model tier). */
export const BrainSpeed = z.enum(BRAIN_SPEEDS).openapi("BrainSpeed", {
  description:
    "How fast it answers in conversations; `fast` applies on a ChatGPT plan with a model that has Fast mode.",
});
export const BrainEffortSetting = z.enum([...BRAIN_EFFORTS, "auto"]).openapi("BrainEffortSetting", {
  description: "A `BrainEffort`, or `auto`: the judge picks low, medium or high for each run.",
});

/** The context limits an agent may choose (`CONTEXT_LIMITS`), in tokens. */
export const ContextLimit = z
  .literal(CONTEXT_LIMITS)
  .openapi("ContextLimit", { description: "The most context an agent reads, in tokens: 200000, 400000 or 1000000." });

export const CommandApproval = z.enum(["always", "low_risk_auto", "never"]).openapi({
  description:
    '"Pedir aprovação de comandos": always (every command off the allow list asks), low_risk_auto (the judge allows low-risk ones within what code allows) or never (everything but the deny list).',
});

export const AccountKind = z.enum(ACCOUNT_KINDS).openapi("AccountKind");

export const MachineAccount = z
  .object({
    id: z.uuid(),
    kind: AccountKind,
    label: z.string(),
    email: z.string().nullable().openapi({ description: "Only for its owner." }),
    plan: z
      .string()
      .nullable()
      .openapi({ description: "`pro`, `max`, `ultra`, `team`, `enterprise`… from what the CLI says." }),
    status: z.enum(["active", "signed_out"]),
    statusKnown: z.boolean().openapi({
      description:
        "False: the computer's last look at its sign-in said nothing for sure (runner protocol 50); `status` is the last known.",
    }),
    ownerId: z.string().nullable().openapi({ description: "Whose account it is; null: nobody's." }),
    ownerName: z.string().nullable(),
    mine: z.boolean().openapi({ description: "The caller owns it: only they rename it or choose it for an agent." }),
    usedBy: z.array(z.string()).openapi({
      description: "Names of the agents that think with it (one at most, unless `shared`).",
    }),
    usedByIds: z.array(z.uuid()).openapi({ description: "Their ids, in the same order." }),
    usage: PlanUsage.nullable().openapi({ description: "Its plan's usage limits; null: not known yet." }),
    provider: z.string().nullable().openapi({
      description: "A key account's coding plan (`zai`, `kimi`, `minimax`, `opencode`); null: the CLI's own sign-in.",
    }),
    keyHint: z.string().nullable().openapi({ description: "The last 4 of a key account's key; only for its owner." }),
    shared: z.boolean().openapi({
      description:
        "It thinks for every agent its owner gives it on that computer, with no new sign-in (runner protocol 29); else for one.",
    }),
    providerOrgId: z.string().nullable().openapi({
      description:
        "Claude's organization it is signed in to (opaque, runner protocol 50); only for its owner. Logins of one email in two organizations are two accounts.",
    }),
    serves: z.enum(["everyone", "owner"]).openapi({
      description:
        "Who it thinks for (ADR 0059 §3): everyone in the workspace (the default), or only its owner. Only its owner changes it.",
    }),
  })
  .openapi("MachineAccount", {
    description:
      "An account of a computer brain on a connected computer (ADR 0041, ADR 0059). Metadata only, never a sign-in.",
  });

/** A computer the caller may give an agent, with what it offers. */
export const BrainMachine = z
  .object({ machineId: z.uuid(), name: z.string(), online: z.boolean(), options: z.array(BrainOption) })
  .openapi("BrainMachine");

export const AgentBrain = z
  .object({
    agentId: z.uuid(),
    scope: z.enum(["mine", "workspace"]).optional().openapi({
      description:
        "The team's right hand only (ADR 0137 §11): `mine`, the caller's own AI for their DM with it (`brain` `model` = none, their DM thinks with the workspace's); `workspace`, the one every DM thinks with while its person has none.",
    }),
    workspaceAi: z
      .object({
        brain: BrainKind,
        ownerId: z.string().nullable(),
        servesYou: z.boolean(),
        key: z.object({ provider: z.string(), label: z.string() }).nullable().optional(),
      })
      .optional()
      .openapi({
        description:
          "The team's right hand: the workspace's AI, `model` for an API key (`key`, by its provider and name; null with none), else the plan's brain and owner; `servesYou`, it thinks for the caller (a key, a plan whose owner lets it serve everyone, or theirs).",
      }),
    brain: BrainKind,
    model: z.string().nullable().openapi({ description: "As stored; null = the brain's default." }),
    effectiveModel: z.string().nullable(),
    fallback: z
      .boolean()
      .openapi({ description: "When the computer can't answer, answer through the API (agent's budget)." }),
    extraUsage: z.boolean().openapi({
      description:
        "Long work may go on into the plan's paid extra usage where the provider reports it on (ADR 0118); false: it pauses at 95%.",
    }),
    computer: z.object({ machineId: z.uuid(), name: z.string(), online: z.boolean() }).nullable(),
    options: z.array(BrainOption),
    machines: z.array(BrainMachine).openapi({
      description:
        "Every computer the caller may give the agent (admins: all; its owner: the ones they connected), with what each offers.",
    }),
    canEdit: z.boolean(),
    account: z
      .uuid()
      .nullable()
      .openapi({ description: "The account its computer brain runs with (ADR 0041); null = the computer's own." }),
    effort: BrainEffortSetting.nullable().openapi({ description: "`auto` = per run; null = the CLI's default." }),
    speed: BrainSpeed,
    contextTokens: ContextLimit.nullable().openapi({
      description: "The most context it reads, any brain; null = its model's window (the smaller one wins).",
    }),
    accounts: z.array(MachineAccount).openapi({
      description:
        "The agent's owner's accounts on its computer, both kinds, and the one it thinks with (ADR 0059); every one there for `canUseOthersPlans`.",
    }),
    canManageAccounts: z.boolean().openapi({
      description:
        "The caller may add an account there for this agent: its owner, on a computer where they add accounts.",
    }),
    accountsSupported: z.boolean().openapi({ description: "The computer's runner knows accounts (protocol 13)." }),
    onlyOwner: z.boolean().openapi({ description: '"Atende outras pessoas" off: nobody but its owner talks to it.' }),
    canUsePlans: z.boolean().openapi({
      description:
        "The caller owns the agent, so its plans are the caller's own: they sign one in for it. Admins choose among its owner's accounts and whom it answers too.",
    }),
    canUseOthersPlans: z.boolean().openapi({
      description:
        "Always true since plans serve the whole workspace (ADR 0059 §3): `accounts` lists every plan on its computer that serves everyone, whoever connected it, and the caller may give it any. Older apps read it.",
    }),
    ownSignIn: z.boolean().openapi({
      description: "The computer's own sign-in can think for it: the person who connected the computer owns the agent.",
    }),
    ownUsage: z
      .object({ claude_code: PlanUsage.optional(), codex: PlanUsage.optional() })
      .openapi({ description: "The computer's own sign-ins' usage limits, by brain (absent: not known)." }),
    autonomy: CommandApproval.openapi({
      description:
        'Its Autonomia: the autonomy its new missions start with ("Usar como padrão"), copied with its setup.',
    }),
    keys: z
      .array(z.object({ id: z.string(), provider: z.string() }))
      .optional()
      .openapi({
        description:
          "The workspace's live API keys, id and provider only: the providers its owner may move it onto (only admins list the keys).",
      }),
  })
  .openapi("AgentBrain");

/** ADR 0094: one agent's "Quem pensa" as a value, to use on other agents. */
export const AgentSetup = z
  .object({
    brain: BrainKind,
    model: z.string().max(80).nullable().openapi({
      description:
        "The API brain: the agent's model (`auto` or a catalog id). A computer brain: its model as `PUT …/brain` takes it; null = the brain's default.",
    }),
    key: z.uuid().nullable().optional().openapi({
      description: "The API brain's key; null = the workspace's default; omitted = each agent keeps its own.",
    }),
    machineId: z.uuid().nullable().optional().openapi({ description: "A computer brain: the computer it thinks on." }),
    account: z
      .uuid()
      .nullable()
      .optional()
      .openapi({ description: "A computer brain: the account there; null = that computer's own sign-in." }),
    effort: BrainEffortSetting.nullable().optional(),
    speed: BrainSpeed.optional().openapi({ description: "Omitted = each agent keeps its own." }),
    contextTokens: ContextLimit.nullable().optional(),
    fallback: z.boolean().optional(),
    onlyOwner: z.boolean().optional().openapi({
      description:
        '"Atende outras pessoas" off, for the agents that move onto the plan (only the plan\'s owner turns it on).',
    }),
    autonomy: CommandApproval.optional().openapi({
      description:
        "Its Autonomia, set wherever the caller may set it by hand (an admin or the agent's owner), whatever the AI takes; omitted = each agent keeps its own.",
    }),
  })
  .openapi("AgentSetup");

export const AgentSetupResult = z
  .object({
    agentId: z.uuid(),
    status: z.enum(["applied", "same", "skipped"]).openapi({
      description:
        "Its AI: `applied` (in a preview: would be); `same`: it already thinks this way; `skipped`: it takes none of the AI (`reason`), and may still take the Autonomia (`autonomy`).",
    }),
    autonomy: z.object({ from: CommandApproval, to: CommandApproval }).optional().openapi({
      description:
        "Its Autonomia changes (in a preview: would), whatever its AI does: wherever the caller may set it by hand, `skipped` agents too.",
    }),
    keeps: z.object({ account: z.string().nullable() }).optional().openapi({
      description: "It keeps the account it has (another person's plan): its name; null = its computer's own.",
    }),
    reason: z
      .enum([
        "not_allowed",
        "admins_only",
        "account_owner",
        "account_single",
        "other_computer",
        "model_missing",
        "failed",
      ])
      .optional(),
    params: z.record(z.string(), z.string()).optional(),
    opensPlan: z.literal(true).optional().openapi({
      description:
        "It lets more people talk to it on its owner's plan, someone else's (in a preview: would): that owner gets an email, so the apps ask first.",
    }),
  })
  .openapi("AgentSetupResult");

export const NewAgentSetup = z
  .object({
    brain: BrainKind,
    model: z.string().nullable(),
    key: z.uuid().nullable(),
    contextTokens: ContextLimit.nullable(),
    computer: z.object({ machineId: z.uuid(), name: z.string() }).optional(),
    account: z
      .object({
        id: z.uuid(),
        label: z.string(),
        provider: z.string().nullable(),
        mine: z.boolean(),
        free: z.boolean().openapi({
          description: "It can think for one more agent (made for all its owner's agents, or used by none).",
        }),
      })
      .nullable()
      .optional(),
    ownSignIn: z
      .boolean()
      .optional()
      .openapi({ description: "The computer's own sign-in thinks for the caller's agents (they connected it)." }),
    effort: BrainEffortSetting.nullable().optional(),
    fallback: z.boolean().optional(),
    autonomy: CommandApproval.nullable().openapi({
      description:
        "Its Autonomia; null = the default. `POST …/agents` takes it only from an admin or the new agent's owner.",
    }),
  })
  .openapi("NewAgentSetup", {
    description: "What a new agent starts thinking with (ADR 0094): the last setup saved or used on other agents.",
  });

export const MissionBrain = z
  .object({
    missionId: z.uuid(),
    brain: BrainKind.nullable().openapi({ description: "The override; null = from the executor." }),
    model: z.string().nullable(),
    effectiveBrain: BrainKind,
    effectiveModel: z.string().nullable(),
    options: z.array(BrainOption),
    canSetBrain: z.boolean().openapi({ description: "Before Start, the owner or someone who decides." }),
    canSetModel: z.boolean().openapi({ description: "While open, the owner or someone who decides." }),
  })
  .openapi("MissionBrain");
