import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrateChat, chatMigrations } from "../src/migrations.js";
import { PostgresAuthStore } from "../src/auth.js";

async function fixture() {
  const db = new PGlite();
  await db.exec(`create table public.user_chat_conversations (
    conversation_id uuid primary key, user_id uuid not null, created_at timestamptz not null default now());
    create table public.chat_messages (id bigint generated always as identity primary key,
    conversation_id uuid, role text, content text, created_at timestamptz default now());`);
  const query = async (sql, args) => args ? db.query(sql, args) : (await db.exec(sql)).at(-1);
  return { db, pool: { query, connect: async () => ({ query, release() {} }) } };
}

test("legacy chat schema upgrades once, supports real authorization, and skips subsequent execution", async () => {
  const { db, pool } = await fixture();
  try {
    assert.equal((await migrateChat(pool, chatMigrations, () => {}))[0].action, "applied");
    const auth = new PostgresAuthStore({}, { pool: { query: async (...args) => {
      const r = await pool.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length };
    } } });
    const user = "11111111-1111-4111-8111-111111111111";
    const conversation = "22222222-2222-4222-8222-222222222222";
    await auth.authorizeConversation(user, conversation, true, { title: "First title" });
    await auth.authorizeConversation(user, conversation, true, { title: "Follow-up" });
    assert.equal((await auth.chatConversations(user))[0].title, "First title");
    assert.equal((await migrateChat(pool, chatMigrations, () => {}))[0].action, "skipped");
    assert.equal((await db.query("select count(*)::int as n from mundusx_internal.chat_migrations")).rows[0].n, 1);
    await assert.rejects(auth.authorizeConversation("33333333-3333-4333-8333-333333333333", conversation, true), /not available/);
  } finally { await db.close(); }
});

test("already migrated schema is adopted without replay and altered migration fails closed", async () => {
  const { db, pool } = await fixture();
  try {
    await db.exec(await readFile(chatMigrations[0].file, "utf8"));
    assert.equal((await migrateChat(pool, chatMigrations, () => {}))[0].action, "adopted");
    await assert.rejects(migrateChat(pool, [{ ...chatMigrations[0], sql: "select 1" }], () => {}), /checksum changed/);
    await db.exec("alter table user_chat_conversations drop column title");
    await assert.rejects(migrateChat(pool, chatMigrations, () => {}), /verification failed/);
  } finally { await db.close(); }
});

test("failure rolls back both schema effects and ledger", async () => {
  const { db, pool } = await fixture();
  try {
    await migrateChat(pool, chatMigrations, () => {});
    await assert.rejects(migrateChat(pool, [{ id: "failure", sql: "create table rollback_probe(id int); select 1/0" }], () => {}));
    assert.equal((await db.query("select to_regclass('rollback_probe') as probe")).rows[0].probe, null);
    assert.equal((await db.query("select count(*)::int as n from mundusx_internal.chat_migrations where id='failure'")).rows[0].n, 0);
  } finally { await db.close(); }
});

test("packaged migration matches canonical SQL", async () => {
  const canonical = await readFile(new URL("../../../db/migrations/0036_chat_conversation_metadata.sql", import.meta.url), "utf8");
  assert.equal((await readFile(chatMigrations[0].file, "utf8")).replace(/\r\n/g,"\n"), canonical.replace(/\r\n/g,"\n"));
});

test("Railway deploy owns migrations; ordinary server starts do not run them", async () => {
  const config = JSON.parse(await readFile(new URL("../railway.json", import.meta.url), "utf8"));
  assert.deepEqual(config.deploy.preDeployCommand, ["npm run db:migrate"]);
  const app = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /migrateChatFromEnv/);
});
