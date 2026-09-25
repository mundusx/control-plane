import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { MediaArtifactStore, RETENTION_SECONDS, UPLOAD_SECONDS } from "../src/features/media/store.js";
import { crc32, validatePng, MAX_IMAGE_BYTES } from "../src/features/media/png.js";
import { createServerApp } from "../src/main.js";

function png() {
  const chunk = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(8); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(8 * 25))), chunk("IEND", Buffer.alloc(0))]);
}
const metadata = (bytes = png()) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), byte_size: bytes.length, width: 8, height: 8 });
const tokenOf = (path) => new URL(path, "http://localhost").searchParams.get("token");

async function fixture(t) {
  const db = new PGlite(), root = await mkdtemp(join(tmpdir(), "mundusx-media-"));
  await db.exec("create table public.users(id uuid primary key, status text not null default 'active')");
  const migration = await readFile(new URL("../../../db/migrations/0037_media_artifacts.sql", import.meta.url), "utf8");
  assert.equal(await readFile(new URL("../migrations/0037_media_artifacts.sql", import.meta.url), "utf8"), migration);
  await db.exec(migration);
  await db.exec(migration); // Independent web startups may repeat this migration.
  const owner = randomUUID(), other = randomUUID();
  await db.query("insert into public.users(id) values($1),($2)", [owner, other]);
  // PGlite is one connection; serialize borrowed transactions like a size-one pg Pool.
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const previous = tail; let release; tail = new Promise((resolve) => { release = resolve; });
      await previous; return { query: db.query.bind(db), release };
    },
    async query(sql, params) { const c = await this.connect(); try { return await c.query(sql, params); } finally { c.release(); } },
  };
  let now = Date.now();
  const store = new MediaArtifactStore({ pool, directory: root, now: () => now });
  t.after(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, root, owner, other, store, pool, advance: (ms) => { now += ms; } };
}

test("private upload survives restart; ready PNG downloads using link only; expiry deletes bytes and row", async (t) => {
  const f = await fixture(t), bytes = png();
  const reservation = await f.store.reserve(f.owner, metadata());
  const id = reservation.artifact_id, token = tokenOf(reservation.download_path);
  await assert.rejects(f.store.download(id, token), { statusCode: 404 });
  const rows = (await f.db.query("select * from media_artifacts")).rows;
  assert.notEqual(rows[0].download_token_hash, token);
  assert.notEqual(rows[0].upload_token_hash, reservation.upload_ticket.upload_token);
  const ready = await f.store.upload(id, reservation.upload_ticket.upload_token, bytes);
  assert.equal(new Date(ready.expires_at) - new Date(ready.ready_at), RETENTION_SECONDS * 1000);
  f.advance(1000);
  const retry = await f.store.upload(id, reservation.upload_ticket.upload_token, bytes);
  assert.equal(String(retry.expires_at), String(ready.expires_at));
  const restarted = new MediaArtifactStore({ pool: f.pool, directory: f.root, now: f.store.now });
  const downloaded = await restarted.download(id, token);
  assert.deepEqual(await downloaded.file.readFile(), bytes); await downloaded.file.close();
  await assert.rejects(f.store.owned(id, f.other), { statusCode: 404 });
  await assert.rejects(f.store.download(id, "a".repeat(64)), { statusCode: 404 });
  f.advance(RETENTION_SECONDS * 1000 - 1000);
  await assert.rejects(f.store.download(id, token), { statusCode: 404 });
  assert.ok(await stat(f.store.file(id))); // Access expires even before the cleanup sweep.
  assert.equal(await f.store.cleanup(), 1);
  await assert.rejects(stat(f.store.file(id)), { code: "ENOENT" });
  assert.equal((await f.db.query("select * from media_artifacts")).rows.length, 0);
});

test("upload tickets are scoped, expire, and cannot publish malformed images", async (t) => {
  const f = await fixture(t);
  const a = await f.store.reserve(f.owner, metadata()), b = await f.store.reserve(f.owner, metadata());
  await assert.rejects(f.store.upload(b.artifact_id, a.upload_ticket.upload_token, png()), { statusCode: 404 });
  await assert.rejects(f.store.upload(a.artifact_id, a.upload_ticket.upload_token, Buffer.from("bad")), { statusCode: 422 });
  const invalid = Buffer.from("not a PNG"), bad = await f.store.reserve(f.owner, metadata(invalid));
  await assert.rejects(f.store.upload(bad.artifact_id, bad.upload_ticket.upload_token, invalid), { statusCode: 422 });
  f.advance(UPLOAD_SECONDS * 1000);
  await assert.rejects(f.store.upload(a.artifact_id, a.upload_ticket.upload_token, png()), { statusCode: 404 });
  assert.equal(await f.store.cleanup(), 3);
});

test("link rotation is owner-only and does not extend retention", async (t) => {
  const f = await fixture(t), r = await f.store.reserve(f.owner, metadata());
  const ready = await f.store.upload(r.artifact_id, r.upload_ticket.upload_token, png());
  await assert.rejects(f.store.renewLink(r.artifact_id, f.other), { statusCode: 404 });
  const rotated = await f.store.renewLink(r.artifact_id, f.owner);
  assert.equal(String(rotated.expires_at), String(ready.expires_at));
  await assert.rejects(f.store.download(r.artifact_id, tokenOf(r.download_path)), { statusCode: 404 });
  const result = await f.store.download(r.artifact_id, tokenOf(rotated.download_path)); await result.file.close();
});

test("concurrent upload retries publish one immutable result and retain its first expiry", async (t) => {
  const f = await fixture(t), r = await f.store.reserve(f.owner, metadata());
  const results = await Promise.all([
    f.store.upload(r.artifact_id, r.upload_ticket.upload_token, png()),
    f.store.upload(r.artifact_id, r.upload_ticket.upload_token, png()),
  ]);
  assert.equal(String(results[0].expires_at), String(results[1].expires_at));
  assert.equal((await f.db.query("select * from media_artifacts where status='ready'")).rows.length, 1);
  assert.deepEqual(await readFile(f.store.file(r.artifact_id)), png());
});

test("failed database commit does not publish a link; retry recovers the staged file", async (t) => {
  const f = await fixture(t), r = await f.store.reserve(f.owner, metadata());
  const originalConnect = f.pool.connect.bind(f.pool);
  f.pool.connect = async () => {
    const client = await originalConnect(), originalQuery = client.query;
    client.query = async (sql, params) => {
      if (sql.includes("set status='ready'")) throw new Error("simulated database failure");
      return originalQuery(sql, params);
    };
    return client;
  };
  await assert.rejects(f.store.upload(r.artifact_id, r.upload_ticket.upload_token, png()), /simulated database failure/);
  await assert.rejects(f.store.download(r.artifact_id, tokenOf(r.download_path)), { statusCode: 404 });
  f.pool.connect = originalConnect;
  assert.equal((await f.store.upload(r.artifact_id, r.upload_ticket.upload_token, png())).status, "ready");
});

test("quotas, image limits and path validation reject unsafe requests", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.reserve(f.owner, { ...metadata(), width: 5000 }), { statusCode: 400 });
  await assert.rejects(f.store.reserve(f.owner, { ...metadata(), content_type: "image/svg+xml" }), { statusCode: 400 });
  await assert.rejects(f.store.lookup("../private"), { statusCode: 404 });
  for (let i = 0; i < 8; i++) await f.store.reserve(f.owner, { ...metadata(), byte_size: MAX_IMAGE_BYTES });
  await assert.rejects(f.store.reserve(f.owner, metadata()), { statusCode: 429 });
  const unrelated = join(f.root, "keep.txt"); await writeFile(unrelated, "keep");
  f.advance(UPLOAD_SECONDS * 1000); await f.store.cleanup();
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});

test("PNG validation checks CRC, dimensions, truncation and trailing data", () => {
  validatePng(png(), 8, 8);
  const corrupt = png(); corrupt[44] ^= 1;
  for (const bytes of [corrupt, png().subarray(0, -1), Buffer.concat([png(), Buffer.from("extra")])]) {
    assert.throws(() => validatePng(bytes, 8, 8), { statusCode: 422 });
  }
  assert.throws(() => validatePng(png(), 1024, 1024), { statusCode: 422 });
});

test("real HTTP routes reserve with current user, upload by ticket, and download without login", async (t) => {
  const f = await fixture(t);
  let sessions = 0;
  const server = createServerApp({ mediaStore: f.store, auth: { required: true }, authStore: {
    async session(req) { sessions++; return req.headers["x-test-user"] ? { id: f.owner } : null; },
    requireCsrf(req) { if (req.headers["x-test-csrf"] !== "valid") throw Object.assign(new Error("CSRF"), { statusCode: 403 }); },
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(base + "/api/media/artifacts", { method: "POST", body: JSON.stringify(metadata()) });
  assert.equal(response.status, 401);
  response = await fetch(base + "/api/media/artifacts", { method: "POST", headers: {
    "x-test-user": "yes", "x-test-csrf": "valid", "content-type": "application/json",
  }, body: JSON.stringify(metadata()) });
  assert.equal(response.status, 201); const reservation = await response.json();
  const before = sessions;
  response = await fetch(base + reservation.upload_ticket.upload_path, { method: "PUT", headers: {
    "Content-Type": "image/png", Authorization: `Bearer ${reservation.upload_ticket.upload_token}`,
  }, body: png() });
  assert.equal(response.status, 200, await response.text());
  response = await fetch(base + reservation.download_path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.match(response.headers.get("content-disposition"), /^attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png());
  assert.equal(sessions, before); // Neither the worker nor a link recipient signs in.
  response = await fetch(base + reservation.preview_path, { method: "HEAD" });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /^inline/);
  f.advance(RETENTION_SECONDS * 1000);
  response = await fetch(base + reservation.download_path); assert.equal(response.status, 404);
});
