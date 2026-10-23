# Media tools for MCP harnesses

The existing MundusX MCP server exposes asynchronous media generation at
`https://chat.mundusx.ai/mcp`. Use Streamable HTTP and an Authorization header
`Bearer <MundusX personal access token>`. Create the token in Chat's account
menu under **MCP connections**. This is separate from selecting EHDA as the
harness's language model; attach this MCP server as a tool provider.

Any harness supporting this MCP transport and bearer authentication can discover
the same tools. Client-specific rendering, background polling and credential
configuration still vary. No Hermes-specific adapter has been verified.

| Tool | Purpose |
| --- | --- |
| `mundusx_media_profiles` | Supported presets, credit estimates and retention |
| `mundusx_generate_image` | Submit an image request and immediately return a job ID |
| `mundusx_generate_video` | Submit a text-to-video request and immediately return a job ID |
| `mundusx_get_media_job` | Read the authenticated user's job state |
| `mundusx_get_media_result` | Obtain expiring result links after completion |

## Harness behavior

Use the generation tool when the user requests media. Supply the original
prompt and a newly generated UUID `idempotency_key`; reuse that UUID if retrying
the same submission, rather than generating duplicate paid jobs. Video accepts
`duration_seconds` from 1 to 10, defaulting to 3. Image currently uses 832x480.

Return the queued job ID to the user without blocking other conversation work.
Check `mundusx_get_media_job` after `poll_after_seconds` (currently 15). Queued
and running are not completion. On completion, call `mundusx_get_media_result`
once and present the returned MCP resource link or download URL. Failed jobs
must be reported as failures; never invent progress percentages or output URLs.
If the client cannot run background checks, retain the job ID and check on the
next user request. MCP itself does not guarantee a harness background scheduler.

Results expire 48 hours after artifact creation. Fetching a result rotates its
access link, so do not fetch new links on every status poll. Jobs and accounting
records remain after media files expire. All job access is user scoped.

## Current boundaries

Profile discovery lists configured supported presets, not live contributor
availability. Immediate no-contributor rejection and live readiness discovery
are not yet provided by these MCP tools. Existing submissions can remain queued
while no eligible contributor is online; clients must not equate a supported
profile with an available GPU.

The video MCP tool currently exposes text-to-video only. Reference upload and
image-to-video tool arguments are not exposed here, even though the HTTP and
browser media flows support references. Adding them requires an owned PNG
upload contract, not arbitrary local filesystem paths.

GX10 contributors can switch between LLM and media modes. Only a connected,
admitted media contributor with the matching verified profile can execute these
jobs. Choosing EHDA as the chat model does not start a media worker.
