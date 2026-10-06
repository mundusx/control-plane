# Media-only contribution and OpenAI-compatible media API

Targets: mundusx/control-plane (ehda media line) and mundusx/mundusx (existing media contributor line). No changes to novusmundus2025 mirrors. No deployment or GX10 generation during implementation.

1. Keep signed identity registration and operator admission. Add explicit verified media profile/budget reporting; admit media-only nodes without pretending they host an LLM. Keep LLM scheduler eligibility separate.
2. Route image, text-to-video and four-step Lightning I2V through the existing fenced queue. Store authenticated reference images, check ownership, and hand them to workers through lease-authorized downloads. Preserve 832x480, aspect ratio and padding.
3. Add /v1/images/generations with synchronous ImagesResponse and /v1/videos creation/status/content, using provider-specific Qwen/Wan model names. Reject unsupported options instead of claiming full OpenAI model compatibility. Reuse MundusX user token authentication and accounting.
4. Route explicit multilingual image/video requests from chat; retain questions, negations and coding requests as text. Reference-image requests choose I2V.
5. Validate contracts, ownership, replay/leases, model/profile mismatch, expiry, media-only LLM exclusion, client response shapes and intent routing. Document join commands and migration requirements; produce reviewable org-scoped changes.

API references: https://developers.openai.com/api/reference/python/resources/images/methods/generate and https://developers.openai.com/api/reference/python/resources/videos/methods/create . No OpenAI API calls or OpenAI credentials are required: compatibility is implemented over local contributor models.

## Rollout

Deploy the companion chat/control-plane and contributor revisions together. Keep existing migrations 0037, 0038, 0040 and 0043 applied, with persistent MUNDUSX_MEDIA_DIR storage. I2V reuses existing artifact/job columns and needs no new migration. Both the CLI and node agent must be updated.

If admission enforces model policy, explicitly allow Qwen/Qwen-Image, Wan-AI/Wan2.2-T2V-A14B and Wan-AI/Wan2.2-I2V-A14B-Lightning as appropriate. Identity, backend, power and memory rules still apply. See the companion contributor document for the media-only install, verification and start commands. Set MUNDUSX_MEDIA_SERVER_URL to this plane's chat service.

Only successfully verified durations are advertised. Verification renders actual output. Image/video requests share one execution slot per contributor; vLLM is not required on a media-only node.

## API contract

Use a user-scoped MundusX personal access token created under MCP connections as the SDK api_key, with base_url=https://YOUR_CHAT_SERVER/v1. This is not an upstream OpenAI credential. Operator/environment API keys without a user owner cannot settle media jobs.

Images: POST /v1/images/generations accepts model=Qwen/Qwen-Image, prompt, n=1, size=832x480, response_format=url or b64_json. It waits for completion and returns an ImagesResponse. A timeout preserves the job and exposes X-MundusX-Job-Id for /v1/media/jobs lookup. Configure gateway/client timeouts for GPU latency, or use the asynchronous media API.

Videos: POST /v1/videos accepts JSON or multipart with prompt, seconds=1-10, size=832x480 and model=Wan-AI/Wan2.2-T2V-A14B. Multipart input_reference selects Wan-AI/Wan2.2-I2V-A14B-Lightning. Creation and GET /v1/videos/{id} return Video objects; GET /v1/videos/{id}/content returns MP4 after completion. GET /v1/models accepts the same user token for media discovery.

This implements a supported subset of OpenAI client request/response shapes using Qwen/Wan names. It does not implement Sora/GPT Image models, edits, remix, deletion, thumbnails, spritesheets, multiple-image output or arbitrary dimensions. Unsupported options are rejected before queueing. Reference inputs are static RGB/RGBA PNG, at most 32 MiB and 4096 pixels per axis, with ownership and expiry checks.

## Chat routing

Explicit supported-language requests route directly. Other languages use the existing bounded LLM planner to classify intent without translating the generation prompt. This fallback requires an available LLM contributor elsewhere on the plane; the GX10 can remain media-only. Ambiguous or unavailable classification falls back to text. Detection is not guaranteed for every possible utterance.

Questions, negations and coding requests must not create jobs. Select Reference PNG in the composer and request a video for I2V; without a reference the request uses T2V.

Fast I2V retains 832x480, four Lightning steps and aspect-preserving padding. Its credit estimates scale the earlier 146360-ms, 33-frame GX10 run. Longer durations and padding were not benchmarked; quotes label the estimate and do not promise generation time or equivalent quality.
