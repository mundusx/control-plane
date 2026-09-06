# MundusX Chat Architecture

MundusX Chat is a modular monolith: one deployable Railway service with explicit internal feature and infrastructure boundaries. Public URLs, authentication rules, and the UAT approval contract remain stable while responsibilities move out of the composition shell incrementally.

## Dependency direction

```text
HTTP/UI -> feature controller -> application service -> domain policy
                                      |
                                      v
                                injected gateway port
                                      |
                                      v
                             infrastructure adapter
```

Feature and domain modules must not import from `main.js`. Infrastructure adapters may depend on shared transport primitives but must not contain UI or domain decisions. `main.js` is the compatibility composition root: it constructs concrete dependencies, starts the server, and temporarily re-exports migrated public functions.

## Source layout

- `src/features/<feature>/`: HTTP controllers, application services, and feature policy.
- `src/adapters/<system>/`: concrete control-plane, database, GitHub, search, and runner transports.
- `src/shared/`: stable cross-cutting primitives such as structured HTTP errors.
- `src/auth.js`: authentication persistence during its feature migration.
- `src/chat-quality.js`: pure output-quality detection and normalization.
- `src/main.js`: composition root plus legacy slices awaiting extraction.

Projects/Harness is the first migrated vertical slice:

- `features/harness/project-policy.js` derives bounded local-project authority without transport dependencies.
- `features/harness/service.js` validates and coordinates Harness workflows through an injected gateway.
- `features/harness/http-controller.js` owns `/api/harness/*` request translation.
- `adapters/control-plane/harness-task-gateway.js` owns control-plane URLs, headers, and response parsing.

MCP is a second thin inbound adapter:

- `features/mcp/http-controller.js` owns bearer authentication and stateless Streamable HTTP transport.
- `features/mcp/server.js` publishes bounded user-scoped tools and translates them into existing Harness and repository services.
- MCP never owns task state, approvals, repository policy, or runner execution.

Skills are application-owned runtime configuration:

- `apps/chat/skills/manifest.json` defines stable skill IDs, metadata, enablement, and files.
- `features/skills/registry.js` validates and loads private Markdown instructions at process startup.
- `features/skills/page.js` renders the no-auth draft and validation preview without exposing or mutating server-side instructions.
- Publishing remains repository-controlled until authenticated, audited skill administration is added.

## Architecture rules

- Preserve a single deployable service; do not introduce microservices for internal code organization.
- Prefer vertical feature slices over global `controllers`, `services`, and `utils` dumping grounds.
- Keep domain policy pure and deterministic.
- Inject external gateways into application services; never call infrastructure from domain policy.
- Keep HTTP request/response objects inside controllers.
- Normalize external payloads at adapter boundaries.
- Use structured errors with stable status codes.
- Preserve compatibility exports during migration, then remove them only through a separately approved API change.
- Do not add generic base services, service locators, or inheritance frameworks.
- Do not let UI code depend on worker internals beyond normalized job state.
- Do not commit generated build output, dependency directories, coverage, or local caches.

## Testing strategy

- Characterization tests protect existing user-visible and API behavior during extraction.
- Feature tests import the feature modules directly.
- Adapter contract tests assert URL, authentication header, payload, and error translation behavior.
- HTTP controller tests use injected stores and services rather than real external systems.
- Browser checks cover project creation, project selection, ordinary chat, themes, and responsive behavior.
- `npm run check --workspace @mundusx/chat` syntax-checks every source module recursively.

## Next extraction order

1. UI shell and browser state.
2. Chat submission and job lifecycle.
3. Deterministic tools and grounding strategies.
4. Conversation persistence.
5. Authentication controllers and adapters.

Each extraction must remain independently testable and deployable; avoid a big-bang rewrite.
