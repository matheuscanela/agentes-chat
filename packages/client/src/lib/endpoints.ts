import type { EndpointCheck, EndpointCheckResult, EndpointModel, EndpointStyle } from "../api/types";

/**
 * "Outro provedor" (ADR 0146), web and phone: a workspace's own OpenAI- or Anthropic-compatible endpoint (a gateway,
 * Ollama, vLLM, LM Studio, LiteLLM) as the form holds it while an admin fills it in.
 */
export const CUSTOM_PROVIDER = "custom";

export const ENDPOINT_STYLES: readonly EndpointStyle[] = ["openai", "openai-responses", "anthropic"];

/** One model of the form: on or off, with its prices as typed (US dollars per million tokens). */
export interface EndpointModelDraft {
  id: string;
  on: boolean;
  input: string;
  output: string;
}

export interface EndpointDraft {
  name: string;
  style: EndpointStyle;
  baseURL: string;
  apiKey: string;
  models: EndpointModelDraft[];
}

export const emptyEndpointDraft = (): EndpointDraft => ({
  name: "",
  style: "openai",
  baseURL: "",
  apiKey: "",
  models: [],
});

/** The address field's example, as each API's SDK takes it. */
export const endpointBaseExample = (style: EndpointStyle) =>
  style === "anthropic" ? "https://api.example.com/anthropic" : "https://api.example.com/v1";

const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
export const MAX_ENDPOINT_MODELS = 30;

/** The models an endpoint listed, merged in: the ones already there keep their choice and prices, new ones start off. */
export function withListedModels(draft: EndpointDraft, listed: readonly { id: string }[]): EndpointDraft {
  const have = new Set(draft.models.map((m) => m.id));
  const fresh = listed.filter((m) => !have.has(m.id)).map((m) => ({ id: m.id, on: false, input: "", output: "" }));
  return { ...draft, models: [...draft.models, ...fresh] };
}

/** A model id typed by hand, added on; null when it doesn't look like one. Already there: switched on. */
export function withTypedModel(draft: EndpointDraft, typed: string): EndpointDraft | null {
  const id = typed.trim();
  if (!MODEL_ID.test(id)) return null;
  if (draft.models.some((m) => m.id === id))
    return { ...draft, models: draft.models.map((m) => (m.id === id ? { ...m, on: true } : m)) };
  return { ...draft, models: [...draft.models, { id, on: true, input: "", output: "" }] };
}

export const withoutModel = (draft: EndpointDraft, id: string): EndpointDraft => ({
  ...draft,
  models: draft.models.filter((m) => m.id !== id),
});

/** A typed price: empty is none, a comma reads as the decimal point; null when it isn't a price. */
export function parsePrice(text: string): number | undefined | null {
  const t = text.trim().replace(",", ".");
  if (!t) return undefined;
  const n = Number(t);
  return /^\d+(\.\d+)?$/.test(t) && Number.isFinite(n) && n <= 10_000 ? n : null;
}

/** Whether a model's typed prices are fine: both or neither. */
export function pricesProblem(m: Pick<EndpointModelDraft, "input" | "output">): "invalid" | "both" | null {
  const input = parsePrice(m.input);
  const output = parsePrice(m.output);
  if (input === null || output === null) return "invalid";
  return (input === undefined) !== (output === undefined) ? "both" : null;
}

/** The chosen models as the API takes them; null while a price is wrong or none is chosen. */
export function endpointModelsOf(draft: Pick<EndpointDraft, "models">): EndpointModel[] | null {
  const on = draft.models.filter((m) => m.on);
  if (on.length === 0 || on.length > MAX_ENDPOINT_MODELS || on.some((m) => pricesProblem(m))) return null;
  return on.map((m) => {
    const input = parsePrice(m.input);
    const output = parsePrice(m.output);
    return { id: m.id, ...(input != null && output != null ? { prices: { input, output } } : {}) };
  });
}

/** The address as the person typed it is worth sending: http(s), with a host. */
export function endpointAddressLooksValid(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Ready to save: a name, an address and at least one model with fine prices. */
export const endpointReady = (draft: EndpointDraft) =>
  draft.name.trim().length > 0 && endpointAddressLooksValid(draft.baseURL) && endpointModelsOf(draft) !== null;

/** A saved endpoint back in the form (changing its models and prices). */
export function draftOfEndpoint(
  label: string,
  endpoint: { style: EndpointStyle; baseURL: string; models: EndpointModel[] },
): EndpointDraft {
  return {
    name: label,
    style: endpoint.style,
    baseURL: endpoint.baseURL,
    apiKey: "",
    models: endpoint.models.map((m) => ({
      id: m.id,
      on: true,
      input: m.prices ? String(m.prices.input) : "",
      output: m.prices ? String(m.prices.output) : "",
    })),
  };
}

/** What a test result says, as a message key, and how it reads (good, a warning, a failure). */
export const CHECK_VIEW = {
  ok: { key: "endpoint.check.ok", tone: "ok" },
  no_tools: { key: "endpoint.check.noTools", tone: "warn" },
  failed: { key: "endpoint.check.failed", tone: "error" },
} as const satisfies Record<EndpointCheckResult, { key: string; tone: "ok" | "warn" | "error" }>;

/** The results in the form's model order; a model with none yet is left out. */
export const checksInOrder = (draft: Pick<EndpointDraft, "models">, checks: readonly EndpointCheck[]) =>
  draft.models.flatMap((m) => checks.filter((c) => c.model === m.id));

/** Whether an agent's model is an endpoint's without prices: its budget then can't count its spend. */
export const modelUnpriced = (models: readonly { id: string; unpriced?: boolean }[] | undefined, model: string) =>
  models?.find((m) => m.id === model)?.unpriced === true;
