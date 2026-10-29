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
# Generated artifacts for existing IDE clients

The API recognizes explicit image file formats and adjacent clarification replies.
PNG uses the existing image queue with durable API delivery. JPG/JPEG, WebP (including `webpn`), BMP, TIFF,
AVIF and still GIF use the image queue for a PNG source, then encode and validate
the requested output. GIF requests ask whether the output is still or animated.

`.sb3` is a separate Scratch project workflow: one generated sprite with a costume
and optional motion/bounce blocks, packaged with `project.json` and assets. Every
archive gets structural/reference validation. Tests load the project in the
official Scratch VM and execute its motion blocks; the production service does
not include the Scratch VM. Complex Scratch programs and animation are unsupported.

Before generation, `/v1/artifacts/plan` on the LangGraph planner checks capability.
Unsupported types return a supported-format question before any job is submitted;
they never silently become ordinary inference jobs. Unknown formats are never
implemented by renaming a PNG. This gate is conservative and rule-based.

Set `MUNDUSX_API_PUBLIC_URL` to the canonical public API origin and optionally
`MUNDUSX_API_ARTIFACT_PLANNER_URL` (default private planner service). Artifacts
are stored under the API data volume with signed 48-hour download links, a
20 MiB file limit and 512 MiB storage limit. The client's existing terminal tool
downloads and checks SHA-256 and file size, refuses overwrites and linked parent
directories, and reports success only after reading back the saved bytes.
Missing/ambiguous workspace context returns a URL with explicit unsaved status.
No changes to VS Code, extensions, or chat.mundusx.ai are required.

## Queue continuity and retries

API image and artifact requests are durably recorded in `artifacts/jobs` on the
API volume. Their identity uses the authenticated key, scene, output type,
destination and workspace, rather than editor history or the calendar date.
An explicit new `request_id` creates a separate request. Repeating the same
request joins the original, including after restart or on a later day.

Background work continues after a client disconnect. The source request uses a
persisted UUID idempotency key; upstream timeouts reattach using the same input.
Once the source image is ready, its checkpoint allows conversion/packaging to
recover without another image-generation job. Startup recovery and periodic
sweeps recover interrupted work with per-request locks. Pending requests have
no automatic age expiry; each API key can have two pending artifact requests,
and the media backend separately enforces its two-per-account media-job limit.

While connected, the chat response stays open, sends a visible pending status
and keepalives, then returns the save instruction automatically when ready.
There is no 20-second cutoff. After a disconnect, say `check image status`,
`resume`, or `retry` in the same conversation to resume that request and its local save.
Generation/conversion can run without VS Code; saving requires a connected
client. Identical existing files are verified instead of rewritten; different
existing content is never overwritten. A verified save receipt is persisted.

Output links still expire after 48 hours. An expired or failed request retains
its history and does not silently create a replacement job. Explicitly request
a new generation when a replacement is needed. Pre-existing legacy queue entries
are not imported into this API request history or deleted by this feature.

Folder-only requests such as `save in assets folder` use that directory and a
stable request-specific filename, so separate generations do not collide with
`generated-image.png`. New default names include the request's Unix creation time
in seconds and a short collision-avoidance suffix, for example
`generated-image-1793280000-e64cc3a4.png`. Retries keep that creation time and name;
previously verified paths are reused. Explicit filenames are used when free or
when they contain identical bytes. If different content already exists, the client
uses a timestamped version of the requested name, preserving the original file.
That version also stays fixed on retry; it is never overwritten with different data.
Save receipts accept
terminal colour/mode sequences and supported output wrappers, but only a complete
receipt line matching the path, hash, size and request ID proves success. Echoed
commands do not count. Destination conflicts return a specific no-overwrite message.

## IDE context latency budget

Agent requests identified by a VS Code/Copilot User-Agent, a `<userRequest>`
envelope, or supported terminal tool names receive an API-side context budget.
This applies to both Chat Completions and converted Responses requests, including
the first request in a fresh chat. Ordinary API chats and the artifact-delivery
path retain their existing behavior; browser-chat sources are unchanged.

Defaults are 24,576 estimated input tokens, a 32,768 total request budget,
4,096 output tokens when the caller supplies no output limit, and 1,024 safety
tokens. Configure `MUNDUSX_API_IDE_INPUT_TOKENS`,
`MUNDUSX_API_IDE_TOTAL_TOKENS`, and `MUNDUSX_API_IDE_OUTPUT_TOKENS` to change these
deployment limits. They are latency limits, not advertised model context windows.
The input allowance is the smaller of the input limit and total minus requested
output minus safety. Explicit output limits are preserved, not silently lowered.

Token estimates use serialized UTF-8 bytes divided by three, rounded up; they
are not measurements from the model tokenizer and do not guarantee model fit.
Old user-led turns are removed as complete groups until the estimate fits.
All system/developer instructions, tool schemas and descriptions, and the current
user turn with its tool exchanges remain intact. A developer notice records that
old context was omitted. No synthetic summary invents facts from removed turns.
Cross-turn tool references and legacy function-call histories are conservatively
kept rather than split. If protected content alone exceeds the budget, the API
returns HTTP 400 `context_budget_exceeded` before forwarding or queuing a job.
This can reject a fresh Agent request; it does not silently shorten its fixed
instructions or tool definitions. Reduce supplied context/tools or use a lighter
client mode, or deliberately raise the deployment budget if latency is acceptable.

The CORS-exposed `X-Mundusx-Context-Budget` header contains before/after serialized
byte sizes, estimated tokens, output reserve, dropped-turn count, and separate
instruction/tool/history/current-turn/other byte counts. Rejections include the
same report under `error.context_budget`. Agent decisions also emit an
`ide_context_budget` structured service log keyed by the API request ID. Reports
contain counts only, with no prompt, tool arguments, file paths or response text.
Editor attachments embedded inside a message count toward that message; their
boundaries cannot reliably be inferred from arbitrary client text. Existing
control-plane dashboard character counts are unchanged.
