# MundusX Chat local-agent bridge

MundusX Chat can use the same local-first agent exposed by the `mundusx` CLI.
The browser never connects to `127.0.0.1`, and the Control Plane never receives
filesystem or shell authority. A local connector makes an outbound HTTPS
connection, claims only tasks owned by the connection token's user, and invokes
the loopback agent API on that machine.

## Connect

1. Sign in to `chat.mundusx.ai` and create a connection token in Account > MCP
   connections. The token is displayed once.
2. Start the connector from the repository or directory the agent may inspect:

   ```powershell
   $env:MUNDUSX_CHAT_TOKEN = "<connection-token>"
   mundusx connect --workspace .
   ```

To expose projects stored in the standard local projects directory, connect its
parent directory:

```powershell
mundusx connect --workspace "$env:USERPROFILE\Documents\mundusx\projects"
```

When the connector is online, ordinary Chat requests prefer the local agent.
If it is offline, Chat uses the existing Control Plane path. Repository-changing
requests remain non-mutating unless a separate, explicit approval flow grants
that authority.

## Runtime selection

The connector reports the runtimes actually available on that user's machine.
`auto` prefers Hermes when its version probe succeeds and otherwise selects the
native MundusX loop. A caller may request `native` or `hermes` explicitly; a
Hermes-only task remains queued rather than being claimed by an incapable
device. Runtime selection is stored with the task for auditability.

Chat exposes four per-account browser choices:

- **Auto** tries a connected local runtime and falls back to MundusX Cloud.
- **Cloud** never requests local filesystem access.
- **Local · MundusX** selects the native local agent.
- **Local · Hermes** requires an advertising Hermes connector and never falls
  back silently to another runtime.

For an active Project, selecting Hermes runs it below the connector workspace
using only the validated project slug. File-changing work requires the visible
one-task edit grant; it resets immediately after submission. Absolute paths,
parent traversal, and projects outside the connector workspace are rejected.
Auto continues to use the bounded MundusX runner and its approval flow for
project mutations.

```text
Internet / MundusX cloud                    User's local machine
┌───────────────────────────────┐  HTTPS   ┌──────────────────────────────┐
│ chat.mundusx.ai               │◄────────►│ mundusx connect              │
│ Google user + task ownership  │          │ workspace + user credentials │
│ runtime selection + audit     │          │                              │
│ no filesystem/shell authority │          │ ┌─────────┐  ┌────────────┐  │
└───────────────────────────────┘          │ │ native  │  │ Hermes     │  │
                                           │ │ runtime │  │ runtime    │  │
                                           │ └─────────┘  └────────────┘  │
                                           └──────────────────────────────┘
```

Hermes remains a local, single-user component. Google authentication identifies
the Chat account; the MCP connection token binds one local connector to that
same account. MundusX does not upload Hermes configuration, provider keys,
skills, memories, transcripts, or tool results.

## Parallel planning

When Hermes advertises its `delegate_task` tool, the Chat model adapter can add
the administrator-controlled **Hermes task planner** skill to complex turns.
The planner asks Hermes to submit one batch of two to four independent,
read-only responsibilities. Each child model request is routed independently by
the MundusX control plane, so compatible contributor slots can work at the same
time. Short requests and dependent steps stay on the direct path.

The parent Hermes task remains the only mutation owner. Delegated children may
inspect, research, discover tests, or review results; they do not own file
changes, approvals, commits, pushes, or completion claims. Independent
validation may fan out after the parent applies changes. Disabling the Hermes
task planner in Global Skills removes this guidance without disabling Hermes or
its ordinary tools.

## Protocol and privacy

The v1 bridge uses `/api/agent/connector/*` with the existing user-scoped MCP
bearer token. Leases prevent two devices from executing the same task, and
heartbeats propagate browser cancellation to the local session. The connector
uploads only the prompt, an allowlisted progress summary, and the final answer;
tool arguments, tool results, file contents, and model transcripts remain local.

Remote connector URLs must use HTTPS. Plain HTTP is accepted only for loopback
development. Revoking the connection token immediately prevents new connector
requests.
