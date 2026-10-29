# Images requested by IDE clients

This optional backend route uses the client's existing OpenAI-compatible model
connection and existing terminal tools. VS Code and its extensions are unchanged;
no MCP connection is required.

Enable `MUNDUSX_CLIENT_IMAGE_DELIVERY_ENABLED=true` only after deploying the matching
planner update. `MUNDUSX_MEDIA_PLANNER_URL` must point to `/v1/media/plan`.
For static model API keys, configure `MUNDUSX_CLIENT_IMAGE_OWNERS` as a JSON object
mapping an existing authenticated API-key **id** to its owning user UUID. This is
server configuration, never a secret or account identifier supplied in a prompt.
Existing personal access tokens are resolved directly to their owning account;
they do not require an API-key-id binding or another client connection.
Connected-agent requests already use their authenticated account. Anonymous model
access is never assigned an arbitrary media owner; it cannot create media through
this route. Existing normal chat remains unchanged.

The gate requires a final user message explicitly asking for image generation,
plus an offered function tool with a terminal/command name and a string command
parameter. Questions, code examples, negations, video requests, read-only clients,
`tool_choice: none`, and tool-result continuations follow the existing chat path.
The feature is disabled by default.

LangGraph selects the image profile and plans a `download_to_workspace` delivery
with `execution_owner: client`. This decision is stored in the durable media job's
request JSON without a schema migration or any absolute workspace path. Media
generation is queued in the existing background queue. Retries with the same
request id and messages reuse the job; clients without request ids reuse identical
requests within the UTC date. A new request id deliberately creates a new job.

The chat request waits up to five minutes; streaming requests receive SSE
keepalive comments. Disconnecting does not cancel the background generation.
Retrying an identical request reconnects to the job. A completed owned artifact
is handed back to the model together with the client's original, unchanged tool
schemas. The model can then issue the client's own terminal command to download
the expiring HTTPS URL into its dynamically selected workspace. Neither the
planner nor the server runs that command or writes into an inference workspace.

Generation completion is not file-save completion. The handoff explicitly says
`file_saved: false`. The client must check its active workspace, preserve the
user's requested relative path, honor approvals/overwrite rules, download, and
verify that the local file exists and is nonempty. If the client cannot execute
tools, it should provide the download URL and state that it has not saved a file.
Closing the IDE stops local execution even though generation can finish remotely.

The handoff does not grant filesystem permission, change client tool schemas,
install an extension, or bypass the client's tool approval mechanism.
