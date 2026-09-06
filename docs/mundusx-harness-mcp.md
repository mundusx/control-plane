# MundusX Harness MCP

MundusX exposes Harness Contract v1.0 through a user-scoped, stateless
Streamable HTTP MCP endpoint hosted by MundusX Chat:

```text
https://chat.mundusx.ai/mcp
```

The MCP layer is an adapter only. EHDA remains authoritative for repository
policy, task state, runner ownership, validation evidence, and approvals.
The endpoint never returns GitHub credentials or the Harness service token.

## Enable in UAT

1. Apply database migration `0025_mcp_personal_access_tokens.sql` using the
   direct `MUNDUSX_DATABASE_URL` migration path.
2. Set `MUNDUSX_MCP_ENABLED=true` on the MundusX Chat Railway service.
3. Retain the existing server-only `MUNDUSX_HARNESS_SERVICE_TOKEN` and pooled
   `MUNDUSX_DATABASE_POOL_URL` variables.
4. Redeploy MundusX Chat and verify `/health` reports `"mcp":"enabled"`.
5. Sign in to MundusX Chat, open the account menu, select **MCP connections**, and
   create a named access token. Copy it immediately; only its SHA-256 digest is
   stored.

Tokens expire after the selected lifetime, can be revoked independently, and
are scoped to the authenticated MundusX user.

## Codex and ChatGPT desktop

Store the token in the local environment rather than in source control:

```powershell
$env:MUNDUSX_MCP_TOKEN = "<token shown once by MundusX Chat>"
```

Add the server in ChatGPT desktop or Codex settings as Streamable HTTP, or add
the following to the user or trusted-project `config.toml`:

```toml
[mcp_servers.mundusx_harness]
url = "https://chat.mundusx.ai/mcp"
bearer_token_env_var = "MUNDUSX_MCP_TOKEN"
```

Restart the client and use `/mcp` to confirm the tools are connected.

## OpenWebUI

In **Settings → Connections**, add a native HTTP MCP connection using the same
server URL and the user token as Bearer authentication. Do not install a Python
Workspace Tool for the Harness; that would execute inside OpenWebUI and bypass
this adapter's intended isolation.

## Tools and safety boundary

The initial server exposes only:

- `mundusx_list_projects`
- `mundusx_read_repository`
- `mundusx_list_runners`
- `mundusx_submit_harness_task`
- `mundusx_get_harness_task`
- `mundusx_cancel_harness_task`

There is no raw shell, approval, merge, push, UAT deployment, or production
deployment tool. Task reads and cancellation verify `requested_by_user_id`.
Repository reads reuse the existing path blocking and credential redaction.

ChatGPT web plugin publication is a separate release step because shared web
plugins require an OAuth-capable remote integration and administrative review.
The bearer-token endpoint is intended for private UAT connections, Codex,
ChatGPT desktop, and OpenWebUI.
