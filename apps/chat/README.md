# MundusX Chat

Legacy standalone chat surface. The OpenAI-compatible adapter and live-weather route now live in the control plane so clients can use one API origin.

Keep this service available only during UAT parity testing. After Open WebUI is pointed at the control-plane `/v1` URL and the smoke tests pass, the `chat-u` deployment can be stopped. The browser UI code remains here until its separate retirement decision.

## Run locally

```powershell
$env:MUNDUSX_CONTROL_PLANE_URL = "https://uat.mundusx.ai"
$env:PORT = "3002"
pnpm --filter @mundusx/chat dev
```

Open `http://127.0.0.1:3002`.

## Railway

Deploy this as a separate Railway service from the control-plane monorepo.

Recommended Railway settings:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/chat` |
| Build Command | empty / Railway default |
| Start Command | `pnpm start` |
| Healthcheck Path | `/health` |

Required environment:

```text
MUNDUSX_CONTROL_PLANE_URL=https://uat.mundusx.ai
```

Optional environment:

```text
MUNDUSX_OPERATOR_TOKEN=<only if the target control plane requires auth>
MUNDUSX_CHAT_MODEL=<optional explicit model override>
MUNDUSX_CHAT_TIMEOUT_SECONDS=90
MUNDUSX_WEATHER_CACHE_URL=<optional redis://, rediss://, valkey://, or valkeys:// URL>
MUNDUSX_FACTUAL_SUMMARY_URL=<optional factual summary API origin>
MUNDUSX_WIKIDATA_ENTITY_URL=<optional Wikidata entity API origin>
MUNDUSX_WEB_SEARCH_API_KEY=<Brave Search API key; web search grounding is disabled without it>
MUNDUSX_WEB_SEARCH_URL=<optional Brave Search API origin override>
MUNDUSX_WEB_SEARCH_MAX_RESULTS=4
MUNDUSX_WEB_SEARCH_TTL_SECONDS=1800
MUNDUSX_WEB_SEARCH_DAILY_BUDGET=<optional daily call cap; 0 or unset means unlimited>
```

Railway provides `PORT`; the app reads it automatically.

## Environment

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port for the chat app |
| `MUNDUSX_CONTROL_PLANE_URL` | `https://uat.mundusx.ai` | Control-plane API origin |
| `MUNDUSX_OPERATOR_TOKEN` | unset | Optional bearer token for protected UAT/API deployments |
| `OPENGPU_OPERATOR_TOKEN` | unset | Deprecated fallback token name |
| `MUNDUSX_CHAT_MODEL` | unset | Optional explicit model override; unset means control-plane routed contributor models |
| `MUNDUSX_CHAT_DEFAULT_MODEL` | unset | Deprecated alias for `MUNDUSX_CHAT_MODEL` |
| `MUNDUSX_CHAT_TIMEOUT_SECONDS` | `90` | Default server-side poll timeout for one chat turn |
| `MUNDUSX_WEATHER_URL` | `https://wttr.in` | Weather API origin for direct weather answers |
| `MUNDUSX_WEATHER_CACHE_URL` | unset | Optional Redis/Valkey URL for weather response caching |
| `VALKEY_URL` | unset | Fallback cache URL when `MUNDUSX_WEATHER_CACHE_URL` is unset |
| `REDIS_URL` | unset | Fallback cache URL when `MUNDUSX_WEATHER_CACHE_URL` and `VALKEY_URL` are unset |
| `MUNDUSX_WEATHER_TTL_SECONDS` | `7200` | Weather cache TTL; default is 2 hours |
| `MUNDUSX_FACTUAL_SUMMARY_URL` | `https://en.wikipedia.org/api/rest_v1/page/summary` | Factual summary API used before LLM jobs for obvious history/who/what questions |
| `MUNDUSX_WIKIDATA_ENTITY_URL` | `https://www.wikidata.org/wiki/Special:EntityData` | Wikidata entity API used for current office-holder questions |
| `MUNDUSX_WEB_SEARCH_URL` | `https://api.search.brave.com/res/v1/web/search` | Brave Search API origin used for general fact-grounding when Web Search/tool mode is on |
| `MUNDUSX_WEB_SEARCH_API_KEY` | unset | Brave Search API key; the web search tool silently declines (falls through to the LLM) without it |
| `MUNDUSX_WEB_SEARCH_MAX_RESULTS` | `4` | Number of search snippets fetched and injected into the grounded prompt |
| `MUNDUSX_WEB_SEARCH_TTL_SECONDS` | `1800` | Web search cache TTL when `MUNDUSX_WEATHER_CACHE_URL`/`VALKEY_URL`/`REDIS_URL` is configured |
| `MUNDUSX_WEB_SEARCH_DAILY_BUDGET` | unset (unlimited) | Optional daily call cap for the web search tool, tracked in the same Redis/Valkey cache; once exceeded the tool declines until the next UTC day |

## Current Flow

1. Browser posts a user message to `POST /api/chat/jobs`.
2. Simple polynomial indefinite integrals are answered directly through the math tool.
3. Obvious weather questions are answered directly through `wttr.in`; if Redis/Valkey is configured the response is cached for 2 hours.
4. Current office-holder questions such as "current president of USA" are answered through Wikidata before using local LLM jobs.
5. Obvious factual history/who/what questions are answered from the factual summary source before using local LLM jobs.
6. When Web Search/tool mode is on, a deterministic grounding gate (`needsGrounding`) decides whether a message looks like it needs current or specific facts (dates, counts, prices, named entities, "who/what/when/how many," etc.) versus conversational or creative requests that never trigger a search. Gated requests query the Brave Search API for a handful of snippets, cached in Redis/Valkey when configured, with an optional daily call budget as a cost circuit breaker.
7. Retrieved snippets are injected into the job's `system_prompt` as a numbered, citable source list with an instruction to answer only from those sources and cite them — the routed MundusX job (any contributor node/model) then only has to synthesize prose from already-verified facts, not decide when or what to search. The response is tagged `tool: "web_search"` with a `sources` list for citation display; a lightweight overlap/citation check logs (but does not yet block) answers that don't appear to use the provided sources.
8. Other requests are submitted as routed MundusX jobs to `POST /v1/jobs` with `execution_mode=auto`.
9. Control plane decides whether the request is single-job or decomposed across graph chunks.
10. Browser polls `GET /api/chat/jobs/:id`, which reads `GET /v1/jobs/:id`.
11. Completed output and graph progress are returned to the browser.

Streaming is not enabled yet; the first version uses polling because the control plane already exposes job status and output.

## Legacy Hermes / OpenAI-Compatible Adapter

New integrations should use the control plane directly:

```text
UAT base URL: https://uat.mundusx.ai/v1
Chat completions: POST /chat/completions
Models: GET /models
Model: mundusx-agnostic (model-agnostic interface over heterogeneous routing)
API key: use `not-required` if the client requires a value
Streaming: accepted as buffered SSE after final validation
```

Example:

```bash
curl https://uat.mundusx.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mundusx-agnostic","messages":[{"role":"user","content":"What is the weather in Warsaw?"}]}'
```

`GET /models` intentionally exposes only `mundusx-agnostic`. It is a stable model-agnostic service
identity, not a physical model. Behind it, the heterogeneous MundusX network lets the planner
privately choose the best eligible contributor node,
runtime, and model for every request. Requested model names, selected physical models, and node
identities are not exposed through the Hermes adapter.

The control-plane gateway preserves prior `messages` as model context, handles live weather through its internal tool module, waits internally for planner-owned MundusX jobs, and returns the validated answer in `choices[0].message.content`.

For Open WebUI, go to **Admin Settings → Connections → OpenAI → Add Connection** and use:

```text
Connection type: External / OpenAI-compatible
URL: https://uat.mundusx.ai/v1
API key: not-required
Model IDs filter: leave empty (auto-discovers mundusx-agnostic)
```

The control plane accepts Open WebUI's default `stream=true`. When a streaming-capable node is available, ordinary text is automatically relayed as live OpenAI-compatible SSE. Structured modes and tool responses remain validated-buffered, and every stream ends with `[DONE]`.
