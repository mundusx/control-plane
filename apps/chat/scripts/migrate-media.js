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
    for (const name of ["0037_media_artifacts.sql", "0038_media_compute_records.sql", "0040_video_jobs.sql", "0043_video_480p.sql", "0044_media_routing.sql", "0047_media_qualification.sql"]) {
      // 0040 was applied atomically. Replaying its old constraint after 14B
      // artifacts exist would reject those rows before the current constraint widens it.
      // 0043 supersedes 0041/0042; replaying narrower constraints rejects 480p rows.
      if (name === "0040_video_jobs.sql" && (await client.query("select to_regclass('public.media_generation_jobs') as relation")).rows[0].relation) continue;
      await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
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
