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
import { MediaAccounting } from "../src/features/media/accounting.js";
import { imageQuote, LEGACY_IMAGE_PROFILE } from "../src/features/media/pricing.js";

function png(size = 8) {
  const chunk = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(size * (size * 3 + 1)))), chunk("IEND", Buffer.alloc(0))]);
}
const metadata = (bytes = png()) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), byte_size: bytes.length, width: 8, height: 8 });
const tokenOf = (path) => new URL(path, "http://localhost").searchParams.get("token");

async function fixture(t) {
  const db = new PGlite(), root = await mkdtemp(join(tmpdir(), "mundusx-media-"));
  await db.exec("create table public.users(id uuid primary key, status text not null default 'active')");
  await db.exec(`create table public.devices(node_id text primary key);
    create table public.jobs(job_id text primary key,status text not null,assigned_node_id text references public.devices(node_id),classification jsonb not null);
    create table public.credits_ledger(id uuid primary key,device_id text references public.devices(node_id),job_id text references public.jobs(job_id),
      entry_type text not null,amount numeric not null,currency text not null,metadata jsonb not null,created_at timestamptz not null);
    insert into public.devices values('gx10');`);
  for (const name of ["0037_media_artifacts.sql", "0038_media_compute_records.sql", "0040_video_jobs.sql"]) {
    const migration = await readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");
    assert.equal(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"), migration);
    await db.exec(migration);
    await db.exec(migration); // Independent web startups may repeat this migration.
  }
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

test("private upload survives restart; expiry deletes bytes but retains owner history", async (t) => {
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
  assert.equal((await f.db.query("select * from media_artifacts")).rows.length, 1);
  assert.equal((await f.store.owned(id, f.owner)).image_available, false);
  assert.ok((await f.store.owned(id, f.owner)).file_deleted_at);
  assert.equal(await f.store.cleanup(), 0);
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

async function quotedJob(f, id = randomUUID()) {
  await f.db.query("insert into jobs values($1,'queued',null,$2)", [id, { operation: "text_to_image", media_profile_id: LEGACY_IMAGE_PROFILE }]);
  const accounting = new MediaAccounting(f.store);
  const quote = await accounting.quoteJob({ job_id: id, owner_user_id: f.owner, profile_id: LEGACY_IMAGE_PROFILE });
  assert.equal(quote.quote.compute_credits, 4);
  await f.db.query("update jobs set status='running',assigned_node_id='gx10' where job_id=$1", [id]);
  const bytes = png(1024);
  const reservation = await f.store.reserve(f.owner, { ...metadata(bytes), width: 1024, height: 1024 });
  await accounting.bindArtifact({ job_id: id, artifact_id: reservation.artifact_id, node_id: "gx10" });
  return { accounting, id, reservation, bytes };
}

test("fixed image quote rejects unbenchmarked profiles and does not price bytes, runtime or text", () => {
  assert.equal(imageQuote().compute_credits, 1199);
  assert.equal(imageQuote().contributor_reward_credits, 1199);
  assert.equal(imageQuote().megapixel_steps, 11.9808);
  assert.equal(imageQuote().pricing_version, "image-megapixel-steps-v1");
  assert.equal(imageQuote(LEGACY_IMAGE_PROFILE).compute_credits, 4);
  assert.equal(imageQuote().cash_price, null);
  assert.equal(imageQuote().width, 832); assert.equal(imageQuote().height, 480);
  assert.equal(imageQuote().calibration, "provisional_policy_not_token_equivalence");
  for (const profile of ["video", "qwen-2048", "", null]) assert.throws(() => imageQuote(profile), { statusCode: 422 });
});

test("completed image earns exactly four credits once; expiry preserves job, quote and ledger", async (t) => {
  const f = await fixture(t), j = await quotedJob(f);
  await f.store.upload(j.reservation.artifact_id, j.reservation.upload_ticket.upload_token, j.bytes);
  await f.db.query("update jobs set status='completed' where job_id=$1", [j.id]);
  const [first, retry] = await Promise.all([
    j.accounting.settle({ job_id: j.id, generation_ms: 216337 }),
    j.accounting.settle({ job_id: j.id, generation_ms: 999999 }),
  ]);
  assert.equal(first.ledger_id, retry.ledger_id);
  const before = (await f.db.query("select * from credits_ledger")).rows;
  assert.equal(before.length, 1); assert.equal(Number(before[0].amount), 4);
  assert.equal(before[0].device_id, "gx10");
  const jobBefore = (await f.db.query("select * from jobs")).rows;
  const computationBefore = await j.accounting.owned(j.id, f.owner);
  await assert.rejects(j.accounting.owned(j.id, f.other), { statusCode: 404 });
  f.advance(RETENTION_SECONDS * 1000);
  await f.store.cleanup();
  await assert.rejects(stat(f.store.file(j.reservation.artifact_id)), { code: "ENOENT" });
  assert.deepEqual((await f.db.query("select * from credits_ledger")).rows, before);
  assert.deepEqual((await f.db.query("select * from jobs")).rows, jobBefore);
  assert.deepEqual(await j.accounting.owned(j.id, f.owner), computationBefore);
  assert.equal((await new MediaAccounting(f.store).settle({ job_id: j.id, generation_ms: 1 })).ledger_id, first.ledger_id);
  assert.equal((await f.db.query("select * from credits_ledger")).rows.length, 1);
});

test("failed jobs, pending uploads, wrong contributors and legacy rewards cannot earn media credits", async (t) => {
  const f = await fixture(t), j = await quotedJob(f);
  await assert.rejects(j.accounting.bindArtifact({ job_id: j.id, artifact_id: j.reservation.artifact_id, node_id: "imposter" }), { statusCode: 409 });
  await assert.rejects(j.accounting.settle({ job_id: j.id, generation_ms: 1 }), { statusCode: 409 });
  await f.db.query("update jobs set status='completed' where job_id=$1", [j.id]);
  await assert.rejects(j.accounting.settle({ job_id: j.id, generation_ms: 1 }), { statusCode: 409 });
  await f.store.upload(j.reservation.artifact_id, j.reservation.upload_ticket.upload_token, j.bytes);
  await f.db.query("update jobs set status='failed' where job_id=$1", [j.id]);
  await assert.rejects(j.accounting.settle({ job_id: j.id, generation_ms: 1 }), { statusCode: 409 });
  await f.db.query("update jobs set status='completed' where job_id=$1", [j.id]);
  await f.db.query("insert into credits_ledger values($1,'gx10',$2,'job_reward',1,'credits','{}',now())", [randomUUID(), j.id]);
  await assert.rejects(j.accounting.settle({ job_id: j.id, generation_ms: 1 }), { statusCode: 409 });
  assert.equal((await f.db.query("select * from credits_ledger")).rows.length, 1);
});

test("settlement rollback cannot leave a paid ledger without its receipt", async (t) => {
  const f = await fixture(t), j = await quotedJob(f);
  await f.store.upload(j.reservation.artifact_id, j.reservation.upload_ticket.upload_token, j.bytes);
  await f.db.query("update jobs set status='completed' where job_id=$1", [j.id]);
  const connect = f.pool.connect.bind(f.pool);
  f.pool.connect = async () => {
    const client = await connect(), query = client.query;
    client.query = (sql, params) => {
      if (sql.includes("set status='settled'")) throw new Error("simulated settlement failure");
      return query(sql, params);
    };
    return client;
  };
  await assert.rejects(j.accounting.settle({ job_id: j.id, generation_ms: 10 }), /simulated settlement failure/);
  assert.equal((await f.db.query("select * from credits_ledger")).rows.length, 0);
  f.pool.connect = connect;
  assert.equal((await j.accounting.settle({ job_id: j.id, generation_ms: 10 })).status, "settled");
});

test("accounting endpoints require dispatcher authority; user quote and history require login", async (t) => {
  const f = await fixture(t);
  const server = createServerApp({ mediaStore: f.store, operatorToken: "private-dispatcher-secret", authStore: {
    async session(req) { return req.headers["x-test-user"] ? { id: f.owner } : null; }, requireCsrf() {},
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const action of ["quote", "bind", "settle"]) {
    const r = await fetch(`${base}/api/media/accounting/${action}`, { method: "POST", headers: { "x-test-user": "yes" }, body: "{}" });
    assert.equal(r.status, 401);
  }
  assert.equal((await fetch(`${base}/api/media/quote`)).status, 401);
  const r = await fetch(`${base}/api/media/quote`, { headers: { "x-test-user": "yes" } });
  assert.equal(r.status, 200); assert.equal((await r.json()).compute_credits, 1199);
});
