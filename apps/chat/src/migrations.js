import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";

// Explicit manifest: never replay the repository's historical migrations on a
// live database. Add new reviewed, transactional Chat migrations here.
export const chatMigrations = [{
  id: "0036_chat_conversation_metadata",
  file: new URL("../migrations/0036_chat_conversation_metadata.sql", import.meta.url),
  verify: `select (
    (select count(*) from information_schema.columns where table_schema='public'
      and table_name='user_chat_conversations' and
      ((column_name='title' and data_type='text')
       or (column_name='pinned' and data_type='boolean')
       or (column_name in ('updated_at','last_message_at') and data_type='timestamp with time zone'))) = 4
    and to_regclass('public.user_chat_conversations_recent_idx') is not null
  ) as ready`,
}];

export async function migrateChat(pool, migrations = chatMigrations, log = console.log) {
  const client = await pool.connect();
  const results = [];
  try {
    for (const migration of migrations) {
      const sql = (migration.sql ?? await readFile(migration.file, "utf8")).replace(/\r\n/g, "\n");
      const checksum = createHash("sha256").update(sql).digest("hex");
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '30s'");
        await client.query("SET LOCAL statement_timeout = '120s'");
        // Transaction-scoped lock works with transaction-mode connection pools.
        await client.query("SELECT pg_advisory_xact_lock(1836413555, 36)");
        await client.query(`CREATE SCHEMA IF NOT EXISTS mundusx_internal`);
        await client.query(`REVOKE ALL ON SCHEMA mundusx_internal FROM PUBLIC`);
        await client.query(`CREATE TABLE IF NOT EXISTS mundusx_internal.chat_migrations (
          id text PRIMARY KEY, checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now(), adopted boolean NOT NULL DEFAULT false)`);
        const existing = await client.query("SELECT checksum FROM mundusx_internal.chat_migrations WHERE id=$1", [migration.id]);
        let action;
        if (existing.rows.length) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Migration checksum changed: ${migration.id}`);
          action = "skipped";
        } else {
          const ready = migration.verify && (await client.query(migration.verify)).rows[0]?.ready === true;
          if (!ready) await client.query(sql);
          action = ready ? "adopted" : "applied";
          await client.query("INSERT INTO mundusx_internal.chat_migrations(id,checksum,adopted) VALUES($1,$2,$3)", [migration.id, checksum, !!ready]);
        }
        if (migration.verify && (await client.query(migration.verify)).rows[0]?.ready !== true) {
          throw new Error(`Migration schema verification failed: ${migration.id}`);
        }
        await client.query("COMMIT");
        results.push({ id: migration.id, action });
        log(`[chat-migration] ${migration.id}: ${action}; schema verified`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return results;
  } finally { client.release(); }
}

export async function migrateChatFromEnv(env = process.env) {
  const connectionString = env.MUNDUSX_DATABASE_POOL_URL || env.DATABASE_URL;
  if (!connectionString) return;
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000 });
  try { return await migrateChat(pool); }
  finally { await pool.end(); }
}
