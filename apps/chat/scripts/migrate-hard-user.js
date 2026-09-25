import { Client } from "pg";
import { readFile } from "node:fs/promises";

if (["true", "1", "yes"].includes(String(process.env.MUNDUSX_AUTH_HARD_USER_ENABLED ?? "").trim().toLowerCase())) {
  const connectionString = process.env.MUNDUSX_DATABASE_URL || process.env.MUNDUSX_DATABASE_POOL_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Username/password login requires PostgreSQL");
  const client = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    await client.query("begin");
    await client.query("set local lock_timeout = '15s'");
    await client.query("select pg_advisory_xact_lock(748291039)");
    await client.query(await readFile(new URL("../migrations/0039_hard_user_login.sql", import.meta.url), "utf8"));
    await client.query("commit");
    console.log("Username/password login storage ready");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("Username/password login migration failed", error.code ?? "database_error");
    process.exitCode = 1;
  } finally { await client.end(); }
}
