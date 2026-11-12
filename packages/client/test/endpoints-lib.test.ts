import { describe, expect, test } from "bun:test";
import type { Credential, Model } from "../src/api/types";
import {
  checksInOrder,
  draftOfEndpoint,
  ENDPOINT_STYLES,
  emptyEndpointDraft,
  endpointAddressLooksValid,
  endpointBaseExample,
  endpointModelsOf,
  endpointReady,
  modelUnpriced,
  parsePrice,
  pricesProblem,
  withListedModels,
  withoutModel,
  withTypedModel,
} from "../src/lib/endpoints";
import { keyRuns, modelChoices } from "../src/lib/providers";

describe("the endpoint form", () => {
  test("three APIs to pick from; the Responses one is addressed like Chat Completions, a saved one comes back as it was", () => {
    expect(ENDPOINT_STYLES).toEqual(["openai", "openai-responses", "anthropic"]);
    expect(endpointBaseExample("openai-responses")).toBe(endpointBaseExample("openai"));
    expect(endpointBaseExample("anthropic")).toBe("https://api.example.com/anthropic");
    const d = draftOfEndpoint("GW", {
      style: "openai-responses",
      baseURL: "https://gw.example/openai/v1",
      models: [{ id: "gpt-x" }],
    });
    expect(d.style).toBe("openai-responses");
  });

  test("a model taken off leaves the others as they were", () => {
    const d = withListedModels(emptyEndpointDraft(), [{ id: "a" }, { id: "b" }]);
    expect(withoutModel(d, "a").models.map((m) => m.id)).toEqual(["b"]);
    expect(d.models).toHaveLength(2);
  });

  test("listed models start off, typed ones on; a typed id that isn't one is refused", () => {
    let d = withListedModels({ ...emptyEndpointDraft(), name: "GW", baseURL: "https://gw.example/v1" }, [
      { id: "a" },
      { id: "b" },
    ]);
    expect(d.models.map((m) => [m.id, m.on])).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(endpointReady(d)).toBe(false);
    expect(withTypedModel(d, "bad id")).toBeNull();
    d = withTypedModel(d, " b ") ?? d;
    d = withTypedModel(d, "c:7b") ?? d;
    expect(d.models.filter((m) => m.on).map((m) => m.id)).toEqual(["b", "c:7b"]);
    // Listing again keeps what was chosen.
    d = withListedModels(d, [{ id: "b" }, { id: "d" }]);
    expect(d.models.map((m) => m.id)).toEqual(["a", "b", "c:7b", "d"]);
    expect(endpointReady(d)).toBe(true);
  });

  test("prices: both or neither, a comma reads as a point, junk is refused", () => {
    expect(parsePrice("")).toBeUndefined();
    expect(parsePrice("0,5")).toBe(0.5);
    expect(parsePrice("1.25")).toBe(1.25);
    expect(parsePrice("-1")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
    expect(pricesProblem({ input: "1", output: "" })).toBe("both");
    expect(pricesProblem({ input: "x", output: "1" })).toBe("invalid");
    const d = {
      models: [
        { id: "a", on: true, input: "1", output: "2" },
        { id: "b", on: true, input: "", output: "" },
        { id: "c", on: false, input: "x", output: "" },
      ],
    };
    expect(endpointModelsOf(d)).toEqual([{ id: "a", prices: { input: 1, output: 2 } }, { id: "b" }]);
    expect(endpointModelsOf({ models: [{ id: "a", on: true, input: "1", output: "" }] })).toBeNull();
    expect(endpointModelsOf({ models: [] })).toBeNull();
  });

  test("an address worth sending; a saved endpoint back in the form; results in the form's order", () => {
    expect(endpointAddressLooksValid("http://localhost:11434/v1")).toBe(true);
    expect(endpointAddressLooksValid("gw.example")).toBe(false);
    const d = draftOfEndpoint("GW", {
      style: "anthropic",
      baseURL: "https://gw.example/anthropic",
      models: [{ id: "x", prices: { input: 1, output: 3 } }, { id: "y" }],
    });
    expect(d.models).toEqual([
      { id: "x", on: true, input: "1", output: "3" },
      { id: "y", on: true, input: "", output: "" },
    ]);
    expect(
      checksInOrder(d, [
        { model: "y", check: "failed", error: "nope" },
        { model: "x", check: "ok" },
      ]).map((c) => c.model),
    ).toEqual(["x", "y"]);
  });
});

describe("endpoint models in the pickers", () => {
  const cred = (id: string, provider = "custom"): Credential => ({
    id,
    provider,
    label: "GW",
    keyHint: "",
    createdAt: "2026-11-04T00:00:00Z",
    revokedAt: null,
  });
  const models: Model[] = [
    {
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      provider: "anthropic",
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
    },
    {
      id: "custom:c1:llama",
      label: "llama",
      provider: "custom",
      inputUsdPerMTok: 0,
      outputUsdPerMTok: 0,
      endpoint: { credentialId: "c1", name: "OpenGateway" },
      unpriced: true,
    },
    {
      id: "custom:c2:other",
      label: "other",
      provider: "custom",
      inputUsdPerMTok: 0,
      outputUsdPerMTok: 0,
      endpoint: { credentialId: "c2", name: "Elsewhere" },
    },
  ];

  test("under the endpoint's name, only this workspace's live endpoints", () => {
    const groups = modelChoices(models, [cred("c1"), cred("k", "anthropic")], false);
    expect(groups.map(([g]) => g)).toEqual(["anthropic", "OpenGateway"]);
    expect(groups[1]?.[1][0]?.available).toBe(true);
    expect(modelChoices(models, [{ ...cred("c1"), revokedAt: "2026-11-04T00:00:00Z" }], false).map(([g]) => g)).toEqual(
      ["anthropic"],
    );
  });

  test("an endpoint's model runs on its own key only; the budget's note for an unpriced one", () => {
    expect(keyRuns(cred("c1"), "custom:c1:llama", models)).toBe(true);
    expect(keyRuns(cred("c1"), "auto", models)).toBe(false);
    expect(keyRuns(cred("k", "anthropic"), "auto", models)).toBe(true);
    expect(keyRuns(cred("c2"), "custom:c1:llama", models)).toBe(false);
    expect(modelUnpriced(models, "custom:c1:llama")).toBe(true);
    expect(modelUnpriced(models, "custom:c2:other")).toBe(false);
    expect(modelUnpriced(undefined, "custom:c1:llama")).toBe(false);
  });
});
