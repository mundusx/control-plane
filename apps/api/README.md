# MundusX inference API

Dedicated Railway service for `https://api.mundusx.ai/v1`, backed by the public contributor fleet. It does not reconnect or modify GX10. The private gateway design is reused, with the GX10 Nemotron non-thinking default for ordinary interactive requests when that exact model is addressed. Explicit thinking settings and tool requests remain authoritative.

## Supported endpoints

- `GET /health`: public service health.
- `GET /v1/models`: authenticated public-router discovery.
- `POST /v1/chat/completions`: caller messages, tools, model and options; JSON replies or live SSE. No browser-chat persona, skills, planner or tool execution is added by this gateway.
- `POST /v1/responses`: stateless text/image input, instructions, function calls/results, JSON replies and typed streaming events. Send complete history and `store:false`. Stateful previous-response IDs, conversations, background requests, stored responses and hosted tools are explicitly unsupported.

This is OpenAI-compatible inference, not OpenAI's account, training, batch, storage or hosted-tools products. Actual model and vision/tool capabilities depend on public contributors. Model IDs are not silently replaced; use the model returned by discovery, currently `mundusx-agnostic`.

The current public router supports one choice (`n=1`). Structured output formats are rejected explicitly because this backend does not enforce them. Function tools work only when a contributor has passed native-tool verification; an unverified backend returns an error rather than a fabricated tool result. Stateless Responses are an adapter, not a persistent Responses store.

## VS Code default chat

Use **Chat: Manage Language Models → Add Models → Custom Endpoint**. Choose **Chat Completions**, use your issued MundusX API key, model ID `mundusx-agnostic` and URL `https://api.mundusx.ai/v1/chat/completions`. Only advertise tool capability when the public worker has verified it.

Official configuration: https://code.visualstudio.com/docs/agent-customization/language-models

## Continue

```yaml
name: MundusX
version: 1.0.0
schema: v1
models:
  - name: MundusX
    provider: openai
    model: mundusx-agnostic
    apiBase: https://api.mundusx.ai/v1
    apiKey: YOUR_ISSUED_MUNDUSX_KEY
    roles: [chat, edit, apply]
```

Official configuration: https://docs.continue.dev/customize/model-providers/top-level/openai

## Deployment and credentials

Deploy this app directory manually with its Dockerfile. `PORT` is respected and `/health` is the health check. Mount a private persistent volume at `/data` for key hashes and metadata-only usage logs. No administrator or worker-control routes are exposed by this service.

| Variable                           | Purpose                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `MUNDUSX_API_UPSTREAM_URL`         | Public control-plane origin                                                   |
| `MUNDUSX_API_UPSTREAM_TOKEN`       | Server-only credential; use a Railway reference to the control-plane variable |
| `MUNDUSX_API_KEY_HASHES`           | Bootstrap JSON array of `{id,user,sha256,revoked}`; no plaintext keys         |
| `MUNDUSX_API_HOME`                 | Persistent state directory, `/data`                                           |
| `MUNDUSX_API_MAX_CONCURRENT`       | Requests per key, default 4                                                   |
| `MUNDUSX_API_MAX_TOTAL_CONCURRENT` | Instance-wide requests, default 32                                            |
| `MUNDUSX_API_MAX_BODY_BYTES`       | Request limit, default 8 MiB                                                  |

An empty key store denies all callers. Client credentials are replaced by the backend credential before forwarding. Additional user keys can be created, listed and revoked through the operator terminal with `node src/keys.js create USERID`, `list`, and `revoke ID`. The creation command shows the new key once. Bootstrap key rotation updates its Railway hash; file-based revocation overrides bootstrap entries. IDs are administrative labels, not verified account identity. Usage metadata is recorded without prompts or answers; account billing integration is not included in this initial gateway.

Streaming uses backpressure and keep-alive instead of final-reply buffering. Disconnects close the upstream connection. POSTs are not automatically replayed. Run `npm test` for compatibility checks and `npm start` for the service.
