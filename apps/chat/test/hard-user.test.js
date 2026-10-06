import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PostgresAuthStore, authConfigFromEnv } from "../src/auth.js";
import { createServerApp, page, configFromEnv } from "../src/main.js";

const env = {
  MUNDUSX_AUTH_GOOGLE_ENABLED: "true", MUNDUSX_AUTH_HARD_USER_ENABLED: "true",
  MUNDUSX_GOOGLE_CLIENT_ID: "test-id", MUNDUSX_GOOGLE_CLIENT_SECRET: "test-secret",
  MUNDUSX_AUTH_HARD_USERNAME: "local-test-user", MUNDUSX_AUTH_HARD_PASSWORD: "test-only-password-12345",
  MUNDUSX_PUBLIC_ORIGIN: "https://chat.example.test",
};

test("provider switches support Google only, fixed user only, both and neither without exposing credentials", () => {
  for (const google of [true, false]) for (const hard of [true, false]) {
    const config = authConfigFromEnv({ ...env, MUNDUSX_AUTH_GOOGLE_ENABLED: String(google), MUNDUSX_AUTH_HARD_USER_ENABLED: String(hard) });
    const store = new PostgresAuthStore(config, { pool: {} });
    assert.equal(store.providers().google, google);
    assert.equal(store.providers().hard_user, hard);
    const html = page({ ...configFromEnv({}), auth: config });
    assert.ok(!html.includes(env.MUNDUSX_AUTH_HARD_PASSWORD));
    assert.ok(!html.includes(env.MUNDUSX_AUTH_HARD_USERNAME));
    assert.ok(!JSON.stringify(store.providers()).includes("password"));
  }
  assert.equal(new PostgresAuthStore(authConfigFromEnv({}), { pool: {} }).providers().hard_user, false);
  assert.equal(new PostgresAuthStore(authConfigFromEnv({ ...env, MUNDUSX_AUTH_HARD_PASSWORD: "" }), { pool: {} }).providers().hard_user, false);
});

async function fixture(t) {
  const db = new PGlite();
  await db.exec(`create table users(id uuid primary key default gen_random_uuid(), email text unique not null,
    display_name text,role text not null,status text not null default 'active',last_login_at timestamptz,updated_at timestamptz default now());
    create table user_sessions(session_hash text primary key,csrf_hash text not null,user_id uuid references users(id),
      provider text not null,expires_at timestamptz not null,revoked_at timestamptz);
    create table github_user_tokens(user_id uuid references users(id));`);
  const sql = await readFile(new URL("../../../db/migrations/0039_hard_user_login.sql", import.meta.url), "utf8");
  assert.equal(await readFile(new URL("../migrations/0039_hard_user_login.sql", import.meta.url), "utf8"), sql);
  await db.exec(sql); await db.exec(sql);
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) };
  const store = new PostgresAuthStore(authConfigFromEnv(env), { pool });
  t.after(() => db.close());
  const response = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, removeHeader(k) { delete this.headers[k]; } };
  const request = { headers: { origin: env.MUNDUSX_PUBLIC_ORIGIN } };
  const input = { username: env.MUNDUSX_AUTH_HARD_USERNAME, password: env.MUNDUSX_AUTH_HARD_PASSWORD };
  return { db, pool, store, response, request, input };
}

test("fixed login uses persistent normal user sessions, supports CSRF/logout, and rotation keeps user history", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.loginHardUser(f.request, f.response, f.input), { ok: true });
  const cookies = f.response.headers["Set-Cookie"];
  assert.ok(cookies[0].includes("Secure; SameSite=Lax; HttpOnly"));
  const cookie = cookies.map(c => c.split(";")[0]).join("; ");
  const request = { headers: { cookie } };
  const session = await f.store.session(request);
  assert.equal(session.display_name, f.input.username); assert.equal(session.role, "user");
  const disabled = new PostgresAuthStore(authConfigFromEnv({ ...env, MUNDUSX_AUTH_HARD_USER_ENABLED: "false" }), { pool: f.pool });
  assert.equal(await disabled.session(request), null);
  const rotated = new PostgresAuthStore(authConfigFromEnv({ ...env, MUNDUSX_AUTH_HARD_PASSWORD: "changed-test-password-123" }), { pool: f.pool });
  assert.equal(await rotated.session(request), null);
  await rotated.loginHardUser(f.request, f.response, { ...f.input, password: "changed-test-password-123" });
  assert.equal((await f.db.query("select * from users")).rows.length, 1);
  const csrf = cookies[1].split(";")[0].split("=")[1];
  await f.store.logout({ headers: { cookie, origin: env.MUNDUSX_PUBLIC_ORIGIN, "x-mundusx-csrf": csrf } }, f.response, session);
  assert.equal(await f.store.session(request), null);
  const rows = (await f.db.query("select * from user_sessions")).rows;
  assert.ok(!JSON.stringify(rows).includes(f.input.password));
});

test("wrong credentials and cross-origin requests cannot log in; database throttling survives store restart", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.loginHardUser({ headers: { origin: "https://other.test" } }, f.response, f.input), { statusCode: 403 });
  for (const input of [{ ...f.input, password: "wrong" }, { ...f.input, username: "wrong" }]) {
    await assert.rejects(f.store.loginHardUser(f.request, f.response, input), { statusCode: 401 });
  }
  assert.equal((await f.db.query("select * from users")).rows.length, 0);
  assert.equal((await f.db.query("select * from user_sessions")).rows.length, 0);
  await f.db.query("update hard_user_login_limits set attempts=20");
  const restarted = new PostgresAuthStore(authConfigFromEnv(env), { pool: f.pool });
  await assert.rejects(restarted.loginHardUser(f.request, f.response, f.input), { statusCode: 429 });
  await f.db.query("update hard_user_login_limits set started_at=now()-interval '6 minutes'");
  assert.deepEqual(await restarted.loginHardUser(f.request, f.response, f.input), { ok: true });
});

test("disabled Google rejects both direct start and callback; disabled fixed login cannot be bypassed", async () => {
  const store = new PostgresAuthStore(authConfigFromEnv({ ...env, MUNDUSX_AUTH_GOOGLE_ENABLED: "false", MUNDUSX_AUTH_HARD_USER_ENABLED: "false" }), { pool: {} });
  await assert.rejects(store.startGoogle("/"), { statusCode: 503 });
  await assert.rejects(store.finishGoogle(new URLSearchParams(), {}), { statusCode: 503 });
  await assert.rejects(store.loginHardUser({ headers: {} }, {}, {}), { statusCode: 503 });
});

test("HTTP login returns secure session cookies and the normal authenticated session endpoint", async (t) => {
  const f = await fixture(t);
  const server = createServerApp({ authStore: f.store, auth: f.store.config });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/hard-user/login`, { method: "POST", headers: { origin: env.MUNDUSX_PUBLIC_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(f.input) });
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  const value = await session.json(); assert.equal(value.user.display_name, f.input.username);
  assert.ok(!JSON.stringify(value).includes("hard_user:"));
});
