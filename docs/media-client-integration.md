# Image and video tools for Copilot and editor agents

MundusX exposes asynchronous media tools through its existing authenticated
Streamable HTTP MCP server at `https://chat.mundusx.ai/mcp`. The same service
has HTTP actions described in `media-openapi.json`.

This requires the media-client server update, migration 0042, persistent media
storage, and an updated contributor with verified Qwen/Wan profiles. Existing
contributors continue receiving only their advertised profiles. Jobs remain
queued until a compatible, admitted contributor is available.

## Connect a client

Create a user token in MundusX settings under MCP connections. Keep it private.
Enable `MUNDUSX_MCP_ENABLED=true` on Chat. The server must have its public origin
configured to produce absolute result URLs. Never use the operator token in a
client.

For VS Code, add this to `.vscode/mcp.json`. The prompted token is not stored
in the project configuration:

```json
{
  "inputs": [{ "type": "promptString", "id": "mundusxToken", "description": "MundusX user token", "password": true }],
  "servers": {
    "mundusx": {
      "type": "http",
      "url": "https://chat.mundusx.ai/mcp",
      "headers": { "Authorization": "Bearer ${input:mundusxToken}" }
    }
  }
}
```

In Copilot Studio, add the MCP server as a tool connection using the same URL
and supported authenticated connection settings. Select the media tools. If
your tenant requires a custom connector, import the HTTP contract and configure
Bearer user-token authentication. Use the client's secret store, not prompts
or instructions, for credentials.

Other extensions can use this interface if they support authenticated remote
MCP. Extensions with HTTP actions can use the asynchronous REST contract.
Extensions that accept only a chat-completions URL need tool integration; a
custom model URL alone does not enable generation.

## Agent instructions

When the user asks to generate an image or video:

1. Check `mundusx_media_profiles` for dimensions and compute-credit estimates.
2. Call `mundusx_generate_image` or `mundusx_generate_video`. Supply a fresh UUID
   idempotency key for each new request; reuse it for retries of that request.
3. Tell the user the job is queued. Retain the returned job ID. Do not invent a
   result URL, progress percentage, or completion time.
4. Use `mundusx_get_media_job`, respecting `poll_after_seconds` (15 seconds).
   If the host cannot wait or continue running tools, report the pending job ID
   and check it when the user asks again. Automatic background notification is
   host-specific and is not supplied by this API.
5. Once completed, call `mundusx_get_media_result` and show its preview/download
   link. Fetch once when delivering the result: requesting another result link
   replaces the previous link. Status polling never rotates links.
6. Report failures and expiry honestly. Media files expire after 48 hours from
   reservation. Job and credit records remain. Links can be downloaded without
   logging in by anyone who possesses the link.

Video duration accepts integer values 1–10. The model generates `16 * seconds
+ 1` frames at 16 FPS; the encoded duration is nominal duration plus one frame.
New durations use provisional frame-scaled compute pricing, not new benchmarks.

## HTTP actions

- `GET /v1/media/profiles`: list supported profiles and quotes.
- `POST /v1/media/jobs`: submit `{kind, prompt, idempotency_key, seed?, duration_seconds?}`.
  Returns HTTP 202 with `job_id`, `state`, `status_url`, and `poll_after_seconds`.
- `GET /v1/media/jobs/{job_id}`: read owner-scoped status and durable records.
- `POST /v1/media/jobs/{job_id}/result`: get expiring absolute download/preview URLs.

All four actions require `Authorization: Bearer <user token>`. Result download
uses the returned capability link. A pending result returns 409; expired media
returns 410; unknown or another user's job returns 404.

## Contributor

Select image/video workloads, complete verification, and start contribution.
The node starts the media worker for selected image or video workloads; a
standalone worker can also be run with:

```sh
opengpu media serve --server https://chat.mundusx.ai
```

The current network admission still requires the existing admitted contributor
path. This update does not add media-only admission. The queue allows one media
job per node and coordinates generation with the local LLM drain mechanism.

## References

- [Copilot Studio MCP](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp)
- [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

Client connection and rendering must be tested in the actual tenant/editor;
passing server protocol tests does not demonstrate an installed client session.
