import type { TFunction } from "i18next";
import type {
  Agent,
  AgentBrain,
  AgentBrainInput,
  AiAccounts,
  BrainMachine,
  MachineAccountKind,
  Model,
  PlanUsage,
} from "../api/types";
import { accountChoices, accountTitle, ownSignInReady } from "./ai-accounts";
import { thinksWith } from "./brain";
import { isClaudeAlias } from "./brain-advanced";
import { namesComputers } from "./machines";
import {
  kindOf,
  PLAN_CHOICES,
  type PlanChoice,
  planLabel,
  planMark,
  planOfAccount,
  planOfKind,
  planSearchNames,
} from "./no-ai";
import {
  type BrainModelChoice,
  brainModelChoice,
  brainModelChoices,
  type CodingPlan,
  modelLimitOf,
  type PlanModelNeed,
  planFreeHint,
  planModelValue,
  planOf,
} from "./plans";
import { AUTO, apiProviderOf, isAuto, type ModelChoice, providerLabel } from "./providers";
import { isRightHand } from "./right-hand";

/*
 * "Quem pensa" as one searchable list (web and phone): the new agent's step offers what the agent's page offers,
 * from the same pieces (`modelChoices` for the API, `PLAN_CHOICES` and `brainModelChoices` for the plans, the same
 * model lines). Automático first, then each API provider's models, then each plan on each computer that runs it with
 * Automático and its models. A coding plan with no key of the person's yet is one pick that connects it once the
 * agent exists; its models show, unpickable, so a search still finds them.
 */

/** What a pick makes the agent think with. */
export type BrainPick =
  | { kind: "model"; model: string }
  | {
      kind: MachineAccountKind;
      choice: PlanChoice;
      machineId: string;
      /** A coding plan's key account of the person's; none: the computer's own sign-in. */
      accountId?: string;
      account?: string;
      model: string;
    }
  /** A plan with nothing to think with yet: the agent is made on Automático, then Connect opens on this plan. */
  | { kind: "connect"; choice: PlanChoice };

export interface BrainPickOption {
  value: string;
  label: string;
  /** What the chosen option reads as ("Sonnet on the Claude plan"). */
  title: string;
  /** Its heading; none for Automático. */
  group?: string;
  /** A `ProviderLogo` id; none: Automático's bulb. */
  mark?: string;
  description?: string;
  /** What the plan's account must allow before it answers, and that as a note behind its ⓘ. */
  needs?: PlanModelNeed;
  hint?: string;
  disabled: boolean;
  free: boolean;
  /** What a search finds it by besides its label, value and group. */
  keywords: string;
  pick: BrainPick;
}

/** Claude's own models describe themselves by family; any other, by its price ("Grátis" for a free one). */
const CLAUDE_FAMILIES = ["sonnet", "opus", "haiku"] as const;
const claudeFamily = (model: Model) =>
  model.provider === "anthropic" ? CLAUDE_FAMILIES.find((f) => model.id.toLowerCase().includes(f)) : undefined;
const freeModel = (model: Model) => model.inputUsdPerMTok === 0 && model.outputUsdPerMTok === 0;

export function modelDescription(t: TFunction, locale: string, model: Model) {
  const family = claudeFamily(model);
  if (family) return t(`newAgent.modelDesc.${family}`);
  if (freeModel(model)) return t("newAgent.modelDesc.free");
  const fmt = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  return t("newAgent.modelDesc.other", { input: fmt(model.inputUsdPerMTok), output: fmt(model.outputUsdPerMTok) });
}

/** A plan's model line, as the agent's page and the new agent's step say it: what it's for, sold as, or costs. */
export function brainModelLine(
  t: TFunction,
  kind: string,
  plan: CodingPlan | undefined,
  m: BrainModelChoice,
  /** Cursor's CLI said which models the plan includes (ADR 0114). */
  cursorPlanSays = false,
): string | undefined {
  if (!plan && kind === "claude_code" && isClaudeAlias(m.value)) return t(`agentPage.work.brain.modelLine.${m.value}`);
  if (!plan && kind === "claude_code" && /^claude-fable-/.test(m.value))
    return t("agentPage.work.brain.modelLine.fable");
  if (cursorPlanSays) return t(m.inPlan ? "brain.cursorModel.inPlan" : "brain.cursorModel.apiPrice");
  const parts = [m.free ? t("brain.free") : undefined, m.tag ? t(`brain.modelTag.${m.tag}`) : undefined];
  return parts.filter(Boolean).join(" · ") || undefined;
}

/** What a search reads of an option. */
export const brainPickText = (o: Pick<BrainPickOption, "label" | "value" | "group" | "keywords">) =>
  `${o.label} ${o.value} ${o.group ?? ""} ${o.keywords}`;

/** The API's models, as the agent's page lists them: each provider's under its name, a long list's good picks first. */
export function apiPickOptions(t: TFunction, locale: string, choices: [string, ModelChoice[]][]): BrainPickOption[] {
  return choices.flatMap(([provider, list]) =>
    list.map(({ model: m, available }) => ({
      value: m.id,
      label: m.label,
      title: m.label,
      group: m.pick ? t("models.picks", { provider: providerLabel(provider) }) : providerLabel(provider),
      mark: provider,
      description: available
        ? modelDescription(t, locale, m)
        : t("newAgent.modelNeedsKey", { provider: providerLabel(provider) }),
      disabled: !available,
      free: freeModel(m),
      keywords: freeModel(m) ? `free ${t("brain.free")}` : "",
      pick: { kind: "model", model: m.id },
    })),
  );
}

/** The first of the person's plan accounts "Quem pensa" offers, on Automático: what a new agent of theirs defaults to. */
export const planAccountOption = (options: readonly BrainPickOption[]) =>
  options.find((o) => !o.disabled && "accountId" in o.pick && Boolean(o.pick.accountId) && o.pick.model === AUTO);

/** A plan account option that wasn't among `before` (the options' values when "Conectar uma IA" opened): the one just connected. */
export const newPlanAccountOption = (options: readonly BrainPickOption[], before: ReadonlySet<string>) =>
  planAccountOption(options.filter((o) => !before.has(o.value)));

/** The API provider whose models a plan also thinks with (Claude's plan: Anthropic's models). */
const PLAN_PROVIDER: Partial<Record<PlanChoice, string>> = { claude: "anthropic", chatgpt: "openai" };

export function brainPickOptions(
  t: TFunction,
  locale: string,
  {
    api,
    machines,
    accounts,
    ownerIsMe,
    held = false,
  }: {
    /** `modelChoices(…)`. */
    api: [string, ModelChoice[]][];
    /** The computers the person may give the agent (`useBrainMachines`). */
    machines: readonly BrainMachine[];
    /** The person's AI accounts (`useAiAccounts`). */
    accounts: AiAccounts["accounts"];
    /** The new agent is the viewer's: only the owner of both the agent and an account chooses it. */
    ownerIsMe: boolean;
    /** A billing hold stops the plans (`planHoldOf`): that, not the computers, is why they are off. */
    held?: boolean;
  },
): BrainPickOption[] {
  const auto: BrainPickOption = {
    value: AUTO,
    label: t("brain.auto.label"),
    title: t("brain.auto.label"),
    description: t("brain.auto.hint"),
    // "Automático" picks from the line of the agent's key: usable once any model is.
    disabled: !api.some(([, list]) => list.some((c) => c.available)),
    free: false,
    keywords: "",
    pick: { kind: "model", model: AUTO },
  };
  const names = namesComputers(machines);
  // The accounts it can think with at once, one per account as the agent's page lists them (`accountChoices`): the
  // viewer's, signed in, and free or made for all of their agents. One in use moves, or signs in once more, only from
  // the agent's page; the server refuses it here (`account.in_use`, `account.not_owner`).
  const ready = ownerIsMe
    ? accountChoices(accounts, [])
        .map((c) => c.login)
        .filter((a) => a.mine && a.status === "active" && (a.shared === true || a.usedBy.length === 0))
    : [];
  const plans = PLAN_CHOICES.flatMap((choice): BrainPickOption[] => {
    const kind = kindOf(choice);
    const coding = planOf(choice);
    const name = thinksWith(t, choice, null);
    const searched = `${name} ${planSearchNames(choice)}`;
    const freeHint = planFreeHint(t, coding);
    const on = machines.filter((m) => m.options.some((o) => o.kind === kind && o.available));
    const rows = (
      base: Omit<Extract<BrainPick, { machineId: string }>, "model">,
      group: string,
      models: BrainModelChoice[],
    ): BrainPickOption[] => {
      const cursorSays = kind === "cursor" && models.some((m) => m.inPlan);
      const key = `${choice}@${base.machineId}${base.accountId ? `#${base.accountId}` : ""}`;
      // Claude's, ChatGPT's or Cursor's account names itself; a coding plan's key is already its plan's name.
      const of = base.account && !coding ? ` · ${base.account}` : "";
      return [
        {
          value: `${key}/${AUTO}`,
          label: t("brain.auto.label"),
          title: `${name}${of}`,
          group,
          mark: planMark(choice),
          // Claude's, ChatGPT's and Cursor's say whose plan it is; a coding plan is the person's own key.
          description: coding ? t("brain.auto.hint") : t(`brain.${kind}Text`),
          ...(freeHint ? { hint: freeHint } : {}),
          disabled: false,
          free: false,
          keywords: searched,
          pick: { ...base, model: AUTO },
        },
        ...models.map((m) => {
          const line = brainModelLine(t, kind, coding, m, cursorSays);
          return {
            value: `${key}/${m.value}`,
            label: m.label,
            title: `${thinksWith(t, choice, m.label)}${of}`,
            group,
            mark: m.maker ?? planMark(choice),
            ...(line ? { description: line } : {}),
            ...(m.needs ? { needs: m.needs, hint: t(`brain.modelNeeds.${m.needs}`) } : {}),
            disabled: false,
            free: m.free === true,
            keywords: `${searched} ${m.maker ? providerLabel(m.maker) : ""} ${m.free ? `free ${t("brain.free")}` : ""}`,
            pick: { ...base, model: m.value },
          };
        }),
      ];
    };
    const mine = ready.filter((a) => planOfAccount(a) === choice && on.some((m) => m.machineId === a.machineId));
    if (coding) {
      const keys = mine;
      if (keys.length === 0) {
        const needs = t("newAgent.brainPick.needsKey", { plan: coding.label });
        return [
          {
            value: `connect:${choice}`,
            label: t("newAgent.brainPick.connect", { plan: coding.label }),
            title: name,
            group: name,
            mark: choice,
            description: t("newAgent.brainPick.connectText", { plan: coding.label }),
            ...(freeHint ? { hint: freeHint } : {}),
            disabled: false,
            free: false,
            keywords: "",
            pick: { kind: "connect", choice },
          },
          ...brainModelChoices(coding, []).map((m) => ({
            value: `connect:${choice}/${m.value}`,
            label: m.label,
            title: thinksWith(t, choice, m.label),
            group: name,
            mark: m.maker ?? choice,
            description: m.free ? `${t("brain.free")} · ${needs}` : needs,
            disabled: true,
            free: m.free === true,
            keywords: `${m.maker ? providerLabel(m.maker) : ""} ${m.free ? `free ${t("brain.free")}` : ""}`,
            pick: { kind: "connect" as const, choice },
          })),
        ];
      }
      return keys.flatMap((a) =>
        rows(
          { kind, choice, machineId: a.machineId, accountId: a.id, account: a.label },
          keys.length > 1 || names ? `${name} · ${a.label}` : name,
          brainModelChoices(coding, []),
        ),
      );
    }
    if (on.length === 0) {
      // Cursor (ADR 0114), OpenCode (ADR 0132), Grok (ADR 0142) and Gemini (ADR 0143) only where a computer runs
      // them; Claude's and ChatGPT's plans say why they can't.
      if (choice === "cursor" || choice === "zen" || choice === "grok" || choice === "gemini") return [];
      return [
        {
          value: `none:${choice}`,
          label: planLabel(t, choice),
          title: name,
          group: name,
          mark: planMark(choice),
          description: held
            ? t("connectAi.billing")
            : machines.length === 0
              ? t("brain.foot.noComputer")
              : t("brain.foot.unavailable"),
          disabled: true,
          free: false,
          keywords: planSearchNames(choice),
          pick: { kind: "connect", choice },
        },
      ];
    }
    const modelsOn = (machineId: string, provider?: string | null) =>
      brainModelChoices(
        undefined,
        on.find((m) => m.machineId === machineId)?.options.find((o) => o.kind === kind)?.models ?? [],
        provider,
      );
    return [
      ...on.flatMap((m) =>
        rows(
          { kind, choice, machineId: m.machineId },
          names || !m.online ? `${name} · ${m.online ? m.name : t("brain.foot.offline", { computer: m.name })}` : name,
          modelsOn(m.machineId),
        ),
      ),
      ...mine
        .map((a) => ({ ...a, label: accountTitle(a) }))
        .flatMap((a) =>
          rows(
            { kind, choice, machineId: a.machineId, accountId: a.id, account: a.label },
            names ? `${name} · ${a.label} · ${a.computer}` : `${name} · ${a.label}`,
            modelsOn(a.machineId, a.provider),
          ),
        ),
    ];
  });
  // A plan ready here thinks with its maker's models: those that would need an API key leave the list, so Claude's
  // models read as the plan's (available), not as "needs a Claude API key".
  const covered = new Set(
    plans.flatMap((o) =>
      !o.disabled && o.pick.kind !== "connect" && "choice" in o.pick ? (PLAN_PROVIDER[o.pick.choice] ?? []) : [],
    ),
  );
  const apiRows = apiPickOptions(t, locale, api).filter((o) => !(o.disabled && o.mark && covered.has(o.mark)));
  return [auto, ...apiRows, ...plans];
}

/** The option a new agent's choice shows as (undefined: one the list no longer has). */
export function brainPickValue(
  options: readonly BrainPickOption[],
  chosen:
    | { kind: "model"; model: string }
    | { kind: "connect"; choice: PlanChoice }
    | { kind: MachineAccountKind; machineId: string; accountId?: string; model?: string },
): string | undefined {
  return options.find((o) => {
    const p = o.pick;
    if (o.disabled) return false;
    if (chosen.kind === "model") return p.kind === "model" && p.model === chosen.model;
    if (chosen.kind === "connect") return p.kind === "connect" && p.choice === chosen.choice;
    return (
      p.kind === chosen.kind &&
      p.machineId === chosen.machineId &&
      (p.accountId ?? null) === (chosen.accountId ?? null) &&
      p.model === (chosen.model ?? AUTO)
    );
  })?.value;
}

/**
 * What a plan chosen for a new agent saves once it exists: its brain, the account, its model (Automático is the
 * agent's own already, carried onto the brain).
 */
export const brainPickInput = (p: {
  kind: MachineAccountKind;
  accountId?: string;
  model?: string;
}): AgentBrainInput => ({
  brain: p.kind,
  ...(p.accountId ? { account: p.accountId } : {}),
  ...(p.model && !isAuto(p.model) ? { model: p.model } : {}),
});

/**
 * A plan picked on a computer's own sign-in that thinks for nobody yet: its sign-in opens once the agent exists (web
 * and phone). Only for an agent of the person's own: only its owner signs a plan in for it.
 */
export function needsOwnSignIn(
  computers: AiAccounts["computers"] | undefined,
  p: { kind: MachineAccountKind; machineId: string; accountId?: string },
) {
  if (p.accountId) return false;
  const row = computers?.find((c) => c.machineId === p.machineId);
  return !ownSignInReady({ ownSignIn: row?.mine === true }, row, p.kind);
}

/** The list's runs of options under one heading, in order (the phone draws each as a group). */
export function pickGroups<O extends Pick<BrainPickOption, "group">>(options: readonly O[]) {
  const out: { group?: string; options: O[] }[] = [];
  for (const o of options) {
    const last = out.at(-1);
    if (last && last.group === o.group) last.options.push(o);
    else out.push({ ...(o.group ? { group: o.group } : {}), options: [o] });
  }
  return out;
}

/** A row of the agent's model page. */
export interface ModelRow {
  value: string;
  label: string;
  /** What it does or is sold as. */
  sub?: string;
  /** What the plan's account must allow before it answers, behind the row's ⓘ. */
  note?: string;
  /** That need's id: chosen, the agent's page says how to give it (`brain.modelHow`). */
  needs?: PlanModelNeed;
  /** Who makes it, on a plan of several makers' models: a provider's id or the maker's name. */
  maker?: string;
  checked: boolean;
}

/**
 * An agent's model as a list, web and phone: Automático, then its brain's models (every model of
 * its account's coding plan, each with what its maker sells it as; Claude's own with what each is for), the one it
 * runs checked.
 */
export function modelRows(
  t: TFunction,
  view: Pick<AgentBrain, "brain" | "effectiveModel" | "options"> & Partial<Pick<AgentBrain, "account" | "accounts">>,
  plan: CodingPlan | undefined,
): ModelRow[] {
  const option = view.options.find((o) => o.kind === view.brain);
  const chosen = brainModelChoice(view.brain, plan, view.effectiveModel ?? option?.defaultModel ?? "");
  const provider = view.accounts?.find((a) => a.id === view.account)?.provider;
  const models = brainModelChoices(plan, option?.models ?? [], provider);
  const cursorSays = view.brain === "cursor" && models.some((m) => m.inPlan);
  const rows: Omit<ModelRow, "checked">[] = [
    { value: AUTO, label: t("brain.auto.label"), sub: t("brain.auto.hint") },
    // The model it runs stays a row when its list doesn't have it, as the web's picker keeps it: one row is checked.
    ...(!chosen || isAuto(chosen) || models.some((m) => m.value === chosen) ? [] : [{ value: chosen, label: chosen }]),
    ...models.map((m) => {
      // What each is for (Claude's own), sold as, or costs: the agent's page's line.
      const sub = brainModelLine(t, view.brain, plan, m, cursorSays);
      return {
        value: m.value,
        label: m.label,
        ...(sub ? { sub } : {}),
        ...(m.needs ? { note: t(`brain.modelNeeds.${m.needs}`), needs: m.needs } : {}),
        ...(m.maker ? { maker: m.maker } : {}),
      };
    }),
  ];
  return rows.map((r) => ({ ...r, checked: r.value === chosen }));
}

/** What picking a model saves, as the web's dialog does: Automático picks the effort too; a fixed one after it, Médio. */
export function modelInput(
  value: string,
  view: Pick<AgentBrain, "effort" | "options" | "brain">,
): Pick<AgentBrainInput, "model" | "effort"> {
  if (isAuto(value)) return { model: AUTO, effort: AUTO };
  const defaultModel = view.options.find((o) => o.kind === view.brain)?.defaultModel;
  return { model: value === defaultModel ? null : value, ...(isAuto(view.effort) ? { effort: "medium" } : {}) };
}

/** Those rows as a select's options: what each is under its name, grouped by maker where a plan has several. */
export const modelRowOptions = (rows: readonly ModelRow[]) =>
  rows.map((r) => ({
    value: r.value,
    label: r.label,
    ...(r.sub ? { description: r.sub } : {}),
    ...(r.maker ? { group: providerLabel(r.maker) } : {}),
  }));

/** A model of a coding plan's key, as "Usar em todos os agentes" lists it. */
export interface KeyModel {
  /** What an agent stores (`planModelValue`). */
  value: string;
  /** The plan's id for it, by which its limits are kept. */
  id: string;
  label: string;
  maker?: string;
  /** It reads text only (no images or PDFs). */
  textOnly: boolean;
  /** Why the plan refused it for this key: switched off there, or its Global region off. */
  refused?: "off" | "region";
}

/**
 * A coding plan key's models in three runs (web and phone): the one that last answered with the key, those the plan
 * refused for it (`modelLimitOf`), and the rest, not tried yet. A model at a limit of its own that resets is none of
 * these: it answers again then, so it counts as not tried.
 */
export function keyModelGroups(
  plan: CodingPlan,
  usage: Pick<PlanUsage, "models" | "answered"> | null | undefined,
  now = Date.now(),
): { works: KeyModel[]; refused: KeyModel[]; untested: KeyModel[] } {
  const out = { works: [] as KeyModel[], refused: [] as KeyModel[], untested: [] as KeyModel[] };
  for (const m of plan.claudeCode.models) {
    const limit = modelLimitOf(usage?.models, m.id, now);
    const row: KeyModel = {
      value: planModelValue(m),
      id: m.id,
      label: m.label,
      ...(m.maker ? { maker: m.maker } : {}),
      textOnly: m.images === false,
    };
    if (limit && (limit.off || limit.region || limit.inactive))
      out.refused.push({ ...row, refused: limit.region ? "region" : "off" });
    else if (usage?.answered === m.id) out.works.push(row);
    else out.untested.push(row);
  }
  return out;
}

/** The model "Usar em todos os agentes" starts on: `preferred` (a value or id) when the key may run it, else the first that works or is untested. */
export function keyModelFirst(groups: ReturnType<typeof keyModelGroups>, preferred?: string | null): string {
  const usable = [...groups.works, ...groups.untested];
  return (usable.find((m) => preferred && (m.value === preferred || m.id === preferred)) ?? usable[0])?.value ?? "";
}

// ── The model picker (the agent's AI in place: the DM's header, its profile card, its side panel) ──

/** An account a plan tile thinks with: one of the owner's on the agent's computer, or that computer's own sign-in. */
export interface PickerAccount {
  /** Null: the computer's own sign-in. */
  id: string | null;
  label: string;
  usage: PlanUsage | null;
  provider: string | null;
}

/** One AI the agent could think with, as a logo tile: a plan on its computer, or an API provider's key. */
export interface PickerTile {
  /** A `PlanChoice`, or `api:<provider>`. */
  key: string;
  /** A `ProviderLogo` id. */
  mark: string;
  name: string;
  kind: MachineAccountKind | "model";
  /** Plan tiles: its accounts, the one in use first, then the one with the most room. */
  accounts: PickerAccount[];
  /** API tiles: the provider. */
  provider?: string;
  /** The agent thinks with it now. */
  current: boolean;
}

/** A model row of the picker. */
export interface PickerModel {
  value: string;
  label: string;
  sub?: string;
  /** Automático: what new agents start with. */
  auto: boolean;
  /** The agent runs it now (on this tile and account). */
  checked: boolean;
  /** The plan refused it for this key (switched off there, its region): dimmed, still pickable to ask again. */
  refused: boolean;
  /** It reads text only. */
  textOnly: boolean;
}

/** How full an account is: its tightest window's use, unknown as empty. */
const usedOf = (u: PlanUsage | null) => Math.max(0, ...(u?.windows.map((w) => w.usedPercent) ?? []));

/**
 * The picker's tiles (web and phone): the plans the agent's computer runs that it has an account for (its owner's, or
 * the one it uses) or a sign-in of its own, in `PLAN_CHOICES` order, then each API provider with a model the workspace
 * can use (and the one it thinks with). Nothing the agent can't switch to in one pick: computers, sign-ins and
 * connecting stay in "Quem pensa".
 */
export function modelPickerTiles(
  t: TFunction,
  view: Pick<AgentBrain, "brain" | "model" | "options" | "accounts" | "account" | "ownSignIn" | "ownUsage">,
  ownerUserId: string | null,
  api: [string, ModelChoice[]][],
  apiModel: string | null,
  models: readonly Model[],
): PickerTile[] {
  const runs = (k: MachineAccountKind) => view.options.some((o) => o.kind === k && (o.available || view.brain === k));
  const byChoice = new Map<PlanChoice, PickerAccount[]>();
  const add = (choice: PlanChoice, a: PickerAccount) => byChoice.set(choice, [...(byChoice.get(choice) ?? []), a]);
  for (const a of view.accounts) {
    const theirs = a.mine || a.ownerId === ownerUserId || a.id === view.account;
    if (!theirs || !runs(a.kind) || (a.status !== "active" && a.id !== view.account)) continue;
    add(planOfAccount(a), { id: a.id, label: accountTitle(a), usage: a.usage, provider: a.provider });
  }
  for (const o of view.options) {
    if (o.kind === "model" || !runs(o.kind)) continue;
    const k = o.kind as MachineAccountKind;
    const own = view.brain === k && view.account === null;
    if (own || (view.ownSignIn && o.available))
      add(planOfKind(k), {
        id: null,
        label: t("brain.picker.ownSignIn"),
        usage: view.ownUsage[k] ?? null,
        provider: null,
      });
  }
  const plans = PLAN_CHOICES.flatMap((choice): PickerTile[] => {
    const accounts = byChoice.get(choice);
    if (!accounts?.length) return [];
    const inUse = (a: PickerAccount) => view.brain !== "model" && (a.id ?? null) === (view.account ?? null);
    const sorted = [...accounts].sort(
      (a, b) => Number(inUse(b)) - Number(inUse(a)) || usedOf(a.usage) - usedOf(b.usage),
    );
    return [
      {
        key: choice,
        mark: planMark(choice),
        name: planLabel(t, choice),
        kind: kindOf(choice),
        accounts: sorted,
        current: sorted.some(inUse) && view.brain === kindOf(choice),
      },
    ];
  });
  const currentProvider = view.brain === "model" ? apiProviderOf(apiModel, models) : undefined;
  const keys = api.flatMap(([provider, list]): PickerTile[] =>
    list.some((c) => c.available) || provider === currentProvider
      ? [
          {
            key: `api:${provider}`,
            mark: provider,
            name: t("brain.picker.apiKey", { provider: providerLabel(provider) }),
            kind: "model",
            accounts: [],
            provider,
            current: provider === currentProvider,
          },
        ]
      : [],
  );
  return [...plans, ...keys];
}

/**
 * The models of a tile (and account), Automático first: a plan's as "Quem pensa" lists them (`modelRows`), the
 * one it runs checked when it is the tile and account in use, those the plan refused for that key dimmed; an API
 * provider's the workspace can use.
 */
export function modelPickerModels(
  t: TFunction,
  locale: string,
  view: Pick<AgentBrain, "brain" | "effectiveModel" | "options" | "account" | "accounts">,
  tile: PickerTile,
  account: PickerAccount | undefined,
  api: [string, ModelChoice[]][],
  apiModel: string | null,
  now = Date.now(),
): PickerModel[] {
  if (tile.kind === "model") {
    const list = api.find(([p]) => p === tile.provider)?.[1] ?? [];
    return [
      {
        value: AUTO,
        label: t("brain.auto.label"),
        sub: t("brain.auto.hint"),
        auto: true,
        checked: tile.current && isAuto(apiModel),
        refused: false,
        textOnly: false,
      },
      ...list
        .filter((c) => c.available || (tile.current && c.model.id === apiModel))
        .map(({ model: m }) => ({
          value: m.id,
          label: m.label,
          sub: modelDescription(t, locale, m),
          auto: false,
          checked: tile.current && m.id === apiModel,
          refused: false,
          textOnly: false,
        })),
    ];
  }
  const kind = tile.kind;
  const here = tile.current && (account?.id ?? null) === (view.account ?? null);
  const plan = planOf(account?.provider);
  const rows = modelRows(
    t,
    {
      brain: kind,
      effectiveModel: here ? view.effectiveModel : AUTO,
      options: view.options,
      account: account?.id ?? null,
      accounts: view.accounts,
    },
    plan,
  );
  const planModels = plan?.claudeCode.models ?? [];
  return rows.map((r) => {
    const m = planModels.find((x) => planModelValue(x) === r.value);
    const limit = m ? modelLimitOf(account?.usage?.models, m.id, now) : null;
    return {
      value: r.value,
      label: r.label,
      ...(r.sub ? { sub: r.sub } : {}),
      auto: isAuto(r.value),
      checked: here && r.checked,
      refused: Boolean(limit && (limit.off || limit.region || limit.inactive)),
      textOnly: m?.images === false,
    };
  });
}

/**
 * What a pick saves: on the tile and account in use, only the model (and Automático's effort, `modelInput`); on
 * another plan or account, the switch the new-agent step makes (`brainPickInput`); on an API tile, the API brain
 * (`brain`: null when it already thinks there) and the model (`model`).
 */
export function modelPickerSave(
  view: Pick<AgentBrain, "brain" | "account" | "effort" | "options">,
  tile: PickerTile,
  account: PickerAccount | undefined,
  value: string,
): { brain: AgentBrainInput | null; model?: string } {
  if (tile.kind === "model") return { brain: view.brain === "model" ? null : { brain: "model" }, model: value };
  const same = view.brain === tile.kind && (account?.id ?? null) === (view.account ?? null);
  if (same) return { brain: { brain: tile.kind, ...modelInput(value, { ...view, brain: tile.kind }) } };
  return {
    brain: {
      ...brainPickInput({ kind: tile.kind, ...(account?.id ? { accountId: account.id } : {}), model: value }),
      ...(account?.id ? {} : { account: null }),
      ...(isAuto(value) ? { model: AUTO, effort: AUTO } : {}),
    },
  };
}

/** What a pick replaced, for its Desfazer: the brain's choice and the API model. */
export interface PickerBefore {
  brain: AgentBrain["brain"];
  account: string | null;
  model: string | null;
  effort: AgentBrain["effort"];
  apiModel: string;
}

/**
 * Desfazer for a pick (`modelPickerSave`): puts back only what that pick saved. It goes by the pick, never by the
 * view it was made from, which is stale by the time the toast's button is pressed.
 */
export function modelPickerUndo(
  before: PickerBefore,
  saved: ReturnType<typeof modelPickerSave>,
): { brain: AgentBrainInput | null; model?: string } {
  const brain: AgentBrainInput | null = !saved.brain
    ? null
    : before.brain === "model"
      ? { brain: "model" }
      : { brain: before.brain, account: before.account, model: before.model, effort: before.effort };
  return saved.model !== undefined && saved.model !== before.apiModel ? { brain, model: before.apiModel } : { brain };
}

/** Whether the viewer changes this agent's AI and model in place: an admin or its owner, never for the team's right hand. */
export function mayPickModel(
  agent: Pick<Agent, "builtin" | "ownerUserId"> | undefined,
  meId: string | null | undefined,
  admin: boolean,
): boolean {
  return Boolean(agent && !isRightHand(agent) && (admin || (meId && agent.ownerUserId === meId)));
}
