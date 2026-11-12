# 0177. A workspace endpoint over OpenAI's Responses API

- Status: Accepted (built)
- Date: 2026-11-12
- Extends: ADR 0146 (a workspace's own model endpoint)
- Code: providers `types.ts` (`Endpoint["style"]`), `custom.ts` (`ENDPOINT_STYLES`, `createCustomProvider`), `openai.ts`
  (the Responses adapter it reuses); engine `endpoints.ts` (`endpointAddress`); db `schema/agents.ts` (`StoredEndpoint`);
  server `routes/app/schemas.ts`; client `api/types.ts` and `lib/endpoints.ts`; web and phone `EndpointForm`; i18n
  `endpoint.styles`

## Context

ADR 0146 lets a workspace point an agent at its own server speaking OpenAI's Chat Completions or Anthropic's Messages.
Some hosted models accept function tools together with reasoning only on the Responses API: on `/v1/chat/completions`
they refuse the call ("Function tools with reasoning_effort are not supported … use /v1/responses"), and some refuse
`max_tokens` there. Agents work through tools, so such a model could be listed but never used (the connect dialog's test
call fails). Gateways that serve these models, such as Amazon Bedrock's `bedrock-mantle` OpenAI-compatible endpoint, also
serve the Responses API at the same address.

## Decision

A third endpoint style, `openai-responses` ("OpenAI (Responses)"), next to `openai` and `anthropic`.

- **The adapter is the one OpenAI's own key already uses** (`createOpenAIProvider`, ADR 0007's catalog provider), given
  the endpoint's `baseURL`: stateless (`store: false`), reasoning replayed as opaque blocks, tools as function items.
  Nothing new speaks the wire protocol.
- **The address is as the SDK takes it** (`https://host/v1`): a pasted `…/responses` is cut, as `/chat/completions` is
  for the `openai` style. The model list is read as for `openai` (`GET {base}/models`).
- **Everything else of ADR 0146 holds**: the key is sealed like any provider key, the model id is `custom:<credentialId>:
  <model>`, a cost the server reports is ignored, prices are the admin's, each model gets one test call, and the same
  address rules apply on Cloud.
- **Stored endpoints need no migration**: `style` is part of the credential's sealed JSON, and a stored `openai` or
  `anthropic` endpoint keeps meaning what it meant.

## Consequences

- A model that needs the Responses API can be used by agents without a translating proxy in front of it.
- The Chat Completions adapter is unchanged: a model that takes `max_tokens` and tools there keeps working as before.
- The style is a choice the admin makes per endpoint; there is no probing for which API a server speaks.
