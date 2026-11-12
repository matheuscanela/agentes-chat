import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

describe("Outro provedor in Settings › Chaves de IA", () => {
  test("named, its models fetched and typed, prices on one, saved and tested: each model's result shows", async () => {
    const state = seedState({
      endpointList: { baseURL: "https://gw.example/v1", models: [{ id: "llama-4" }, { id: "qwen-3" }] },
      endpointChecks: { "qwen-3": { model: "qwen-3", check: "no_tools" } },
    });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    await pick(within(add).getByRole("combobox", { name: "Provedor" }), /Outro provedor/);

    const save = () => within(add).getByRole("button", { name: "Salvar e testar" });
    expect(save().hasAttribute("disabled")).toBe(true);
    await type(within(add).getByLabelText("Nome"), "OpenGateway");
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1/");
    await type(within(add).getByLabelText("Chave de API"), "gw-key-1234567");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    expect(state.calls.find((c) => c.method === "agents.endpointModels")?.args[1]).toMatchObject({
      style: "openai",
      baseURL: "https://gw.example/v1/",
      apiKey: "[redacted]",
    });
    // Listed models start off: nothing to save yet.
    expect(save().hasAttribute("disabled")).toBe(true);
    await click(within(add).getByRole("checkbox", { name: "llama-4" }));
    await type(within(add).getByLabelText("llama-4: preço de entrada"), "1");
    expect(add.textContent).toContain("Preencha entrada e saída, ou nenhum dos dois.");
    await type(within(add).getByLabelText("llama-4: preço de saída"), "2,5");
    await type(within(add).getByLabelText("Adicionar um modelo"), "qwen-3");
    await click(within(add).getByRole("button", { name: "Adicionar" }));
    expect(add.textContent).toContain("Um modelo sem preço não custa nada nos orçamentos");
    await click(save());
    await settle(4);

    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toEqual({
      provider: "custom",
      label: "OpenGateway",
      apiKey: "[redacted]",
      endpoint: {
        style: "openai",
        baseURL: "https://gw.example/v1",
        models: [{ id: "llama-4", prices: { input: 1, output: 2.5 } }, { id: "qwen-3" }],
      },
    });
    expect(add.textContent).toContain("llama-4 · Funciona, com ferramentas");
    expect(add.textContent).toContain("qwen-3 · Responde, mas não usou ferramenta.");
    await click(within(add).getByRole("button", { name: "Concluir" }));
    expect(screen().queryByRole("dialog", { name: "Adicionar chave de API" })).toBeNull();
  });

  const openForm = async (state = seedState()) => {
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(5);
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    await pick(within(add).getByRole("combobox", { name: "Provedor" }), /Outro provedor/);
    return { add, api };
  };

  test("the API is picked among three: Responses is sent as its own style when the models are fetched", async () => {
    const state = seedState({ endpointList: { baseURL: "https://gw.example/openai/v1", models: [{ id: "gpt-x" }] } });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    await pick(within(add).getByRole("combobox", { name: "Provedor" }), /Outro provedor/);

    const styles = within(add).getAllByRole("radio");
    expect(styles.map((r) => r.textContent)).toEqual([
      "OpenAI (Chat Completions)",
      "OpenAI (Responses)",
      "Claude (Messages)",
    ]);
    expect(styles[0]?.getAttribute("aria-checked")).toBe("true");
    await click(within(add).getByRole("radio", { name: "OpenAI (Responses)" }));
    expect(within(add).getByRole("radio", { name: "OpenAI (Responses)" }).getAttribute("aria-checked")).toBe("true");
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/openai/v1");
    await type(within(add).getByLabelText("Chave de API"), "gw-key-1234567");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    expect(state.calls.find((c) => c.method === "agents.endpointModels")?.args[1]).toMatchObject({
      style: "openai-responses",
      baseURL: "https://gw.example/openai/v1",
    });
  });

  test("laid out as a dialog: its fields in the body, Buscar modelos on the label's line, Cancelar then the save in the footer", async () => {
    const { add } = await openForm();
    const body = add.querySelector(".ac-dialog__body") as HTMLElement;
    expect(body.querySelector(".ac-brand__initial")).toBeNull();
    expect(body.querySelector('.ac-brand[data-mark="custom"]')).not.toBeNull();
    expect(within(body).getByRole("radiogroup", { name: "API" }).closest(".ac-field")).not.toBeNull();
    const fetch = within(body).getByRole("button", { name: "Buscar modelos" });
    expect(fetch.closest(".ac-field__label-row")?.textContent).toContain("Adicionar um modelo");
    expect(fetch.className).not.toContain("ac-btn");
    expect(within(body).getByRole("button", { name: "Adicionar" }).closest(".ac-input-affix")).not.toBeNull();
    const foot = add.querySelector(".ac-dialog__foot") as HTMLElement;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancelar", "Salvar e testar"]);
    await click(within(foot).getByRole("button", { name: "Cancelar" }));
    expect(screen().queryByRole("dialog", { name: "Adicionar chave de API" })).toBeNull();
  });

  test("by keyboard: Enter adds without saving, the + and a × leave the focus in the field, Buscar modelos comes before it", async () => {
    const { add, api } = await openForm();
    const typed = within(add).getByLabelText("Adicionar um modelo") as HTMLInputElement;
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    let saves = 0;
    (api.agents as { addCredential: unknown }).addCredential = () => {
      saves += 1;
      return new Promise(() => {});
    };
    await type(typed, "llama-4");
    await act(async () => fireEvent.keyDown(typed, { key: "Enter" }));
    await settle();
    expect(saves).toBe(0);
    expect(screen().queryByRole("dialog", { name: "Adicionar chave de API" })).not.toBeNull();
    expect(within(add).queryByRole("checkbox", { name: "llama-4" })).not.toBeNull();

    await type(typed, "qwen-3");
    const plus = within(add).getByRole("button", { name: "Adicionar" });
    await act(async () => plus.focus());
    await click(plus);
    expect(document.activeElement).toBe(typed);
    const remove = within(add).getByRole("button", { name: "Remover qwen-3" });
    await act(async () => remove.focus());
    await click(remove);
    expect(document.activeElement).toBe(typed);

    const fetch = within(add).getByRole("button", { name: "Buscar modelos" }) as HTMLButtonElement;
    expect(fetch.disabled).toBe(false);
    expect(fetch.compareDocumentPosition(typed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("Enter adds a typed model, its × takes it off, and while saving every control is off", async () => {
    const { add, api } = await openForm();
    await type(within(add).getByLabelText("Nome"), "OpenGateway");
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    const typed = within(add).getByLabelText("Adicionar um modelo");
    for (const id of ["llama-4", "qwen-3"]) {
      await type(typed, id);
      await act(async () => fireEvent.keyDown(typed, { key: "Enter" }));
      await settle();
    }
    expect((typed as HTMLInputElement).value).toBe("");
    await click(within(add).getByRole("button", { name: "Remover qwen-3" }));
    expect(within(add).queryByRole("checkbox", { name: "qwen-3" })).toBeNull();
    expect(within(add).getByRole("checkbox", { name: "llama-4" })).toBeDefined();

    (api.agents as { addCredential: unknown }).addCredential = () => new Promise(() => {});
    await click(within(add).getByRole("button", { name: "Salvar e testar" }));
    expect(add.textContent).toContain("Testando cada modelo…");
    expect(within(add).getByRole("button", { name: "Cancelar" }).hasAttribute("disabled")).toBe(true);
    expect(add.querySelector("fieldset.ac-locked")?.hasAttribute("disabled")).toBe(true);
    expect(
      add.querySelector("fieldset.ac-locked")?.contains(within(add).getByRole("combobox", { name: "Provedor" })),
    ).toBe(true);
  });
});
