import { readFile } from "node:fs/promises";
import { Client } from "pg";

// Railway builds apps/chat independently from the Rust control plane.
if (process.env.MUNDUSX_MEDIA_DIR?.trim()) {
  const connectionString = process.env.MUNDUSX_DATABASE_URL;
  if (!connectionString) throw new Error("Media migration requires MUNDUSX_DATABASE_URL (direct PostgreSQL connection)");
  const client = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    await client.query("begin");
    await client.query("set local lock_timeout = '15s'");
    await client.query("select pg_advisory_xact_lock(748291037)");
    await client.query(await readFile(new URL("../migrations/0037_media_artifacts.sql", import.meta.url), "utf8"));
    await client.query("commit");
    console.log("Media artifact migration ready");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("Media migration failed", error.code ?? "connection_or_schema_error");
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
