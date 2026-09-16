# Chat startup migrations

Chat runs its reviewed migration manifest before opening the HTTP listener.
The packaged SQL is included under `apps/chat/migrations` because manual Chat
uploads use that directory as their deployment root. A test compares packaged
SQL with the canonical `db/migrations` file.

Each migration takes a transaction-scoped advisory lock, checks
`mundusx_internal.chat_migrations`, applies missing SQL, verifies the resulting
schema, and records a normalized SHA-256 checksum in the same transaction.
Successful migrations are skipped on later starts. A database already matching
the verification query is adopted without replaying the migration. A failure
rolls back the schema and ledger together and prevents the new server from
accepting requests. Changed historical SQL or schema drift also fails startup.

The initial manifest contains only `0036_chat_conversation_metadata`; it does
not automatically execute the entire historical migration directory. Future
Chat schema changes must add a new immutable SQL file, manifest entry and
verification query. Existing installations must have the base Chat tables.
Startup logs distinguish `applied`, `adopted`, and `skipped`.

No request-time migrations, timers, GitHub Actions, credentials in logs or
public migration endpoints are used. The ledger lives in a private schema.
