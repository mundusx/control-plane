# Chat API keys: environment allowlist

Configure `MUNDUSX_CHAT_API_KEYS` on **both** the Chat service and the control-plane service that expose OpenAI-compatible endpoints. The value is a JSON array:

```json
[{"id":"alice-vscode","key":"<replace-with-a-generated-secret>"},{"id":"build-agent","key":"<replace-with-another-generated-secret>"}]
```

These are placeholders, not usable credentials. Generate a separate random key for each client using:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Copy each generated value into the server's secret environment settings and that client's API-key setting. Keep keys out of source control, screenshots, browser JavaScript, and prompts. Use HTTPS. Keys must contain 32-256 visible ASCII characters. IDs must be unique, 1-80 letters, digits, hyphens or underscores. Duplicate keys are rejected.

## Rollout and use

1. Generate and securely distribute client keys.
2. Set `MUNDUSX_CHAT_API_KEYS` on both services. Configure the same nonempty `MUNDUSX_OPERATOR_TOKEN` on Chat and the control plane for existing server-to-server requests. Never give the operator token to external clients.
3. Restart/redeploy both services. Updating one origin alone leaves the other origin's current access policy unchanged.
4. Keep the client's existing OpenAI-compatible base URL and model. Enter its generated key in VS Code's API-key setting. Clients send `Authorization: Bearer <key>`.
5. Verify `/v1/models` succeeds with a valid key and returns HTTP 401 without it. Streaming and non-streaming completions, status and cancellation endpoints also require authentication. Cancellation still requires the private resume token.

When the variable is **absent**, legacy anonymous access remains for rollout compatibility. When set to `[]`, all external keys are denied. A blank or malformed value never enables anonymous access: Chat refuses startup, and the control plane rejects protected requests with HTTP 503. Do not unset the variable to revoke the last key; set `[]` instead.

The control plane accepts its server-only operator token for internal Chat calls even with an empty external list. Browser Chat continues using its existing session routes, and MCP/agent access continues using personal tokens. This list grants inference access, not administrator rights. It is separate from `MUNDUSX_AGENT_MODEL_API_KEYS`, which contains credentials for upstream model providers.

## Revocation and current limits

Remove an entry, or replace its secret to rotate it, then restart **every service/replica** using the list. Subsequent requests with the old key receive HTTP 401; in-flight requests are not forcibly cancelled. Environment changes do not take effect in an already-running process.

The configured ID is a stable administrative label, not verified account ownership. This first stage does not persist request attribution, store prompts, provide an admin key-list page, or allow database-driven revocation. Those require the next database-backed stage. A shared key identifies only the shared credential, not the individual person using it.
