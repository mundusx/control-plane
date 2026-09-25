import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { httpError } from "../../shared/http-error.js";
import { MAX_IMAGE_BYTES, validatePng } from "./png.js";

import { MAX_VIDEO_BYTES, validateVideo } from "./video.js";

export const RETENTION_SECONDS = 48 * 60 * 60;
export const UPLOAD_SECONDS = 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const matches = (secret, expected) => SECRET.test(secret ?? "") && SECRET.test(expected ?? "") &&
  timingSafeEqual(Buffer.from(hash(secret), "hex"), Buffer.from(expected, "hex"));
const notFound = () => httpError(404, "Image not available or link expired");

export function validateMetadata(input) {
  if (input?.content_type === "video/mp4") {
    if (!SECRET.test(input.sha256 ?? "") || !Number.isSafeInteger(input.byte_size) || input.byte_size < 1 || input.byte_size > MAX_VIDEO_BYTES ||
        input.width !== 1280 || input.height !== 704 ||
        !((input.fps === 24 && [49,121,241].includes(input.frames)) ||
          (input.fps === 16 && [33,81,161].includes(input.frames)))) throw httpError(400, "Invalid video preset metadata");
    return { sha256: input.sha256, byte_size: input.byte_size, width: input.width, height: input.height, content_type: "video/mp4", frames: input.frames, fps: input.fps };
  }
  if (!input || !SECRET.test(input.sha256 ?? "") || !Number.isSafeInteger(input.byte_size) ||
      input.byte_size < 1 || input.byte_size > MAX_IMAGE_BYTES ||
      !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) ||
      input.width < 1 || input.height < 1 || input.width > 4096 || input.height > 4096 ||
      (input.content_type !== undefined && input.content_type !== "image/png")) {
    throw httpError(400, "Expected PNG metadata: sha256, byte_size (up to 32 MiB), width and height (up to 4096)");
  }
  return { sha256: input.sha256, byte_size: input.byte_size, width: input.width, height: input.height };
}

function publicRecord(row, now = Date.now()) {
  return { artifact_id: row.artifact_id, status: row.status, content_type: row.content_type ?? "image/png", frames: row.frames ?? null, fps: row.fps ?? null,
    sha256: row.sha256, byte_size: row.byte_size, width: row.width, height: row.height,
    ready_at: row.ready_at, expires_at: row.expires_at, retention_seconds: RETENTION_SECONDS,
    file_deleted_at: row.file_deleted_at ?? null,
    media_available: row.status === "ready" && !row.file_deleted_at && new Date(row.expires_at).getTime() > now,
    image_available: row.content_type !== "video/mp4" && row.status === "ready" && !row.file_deleted_at && new Date(row.expires_at).getTime() > now };
}

export class MediaArtifactStore {
  constructor({ pool, directory, now = () => Date.now() }) {
    if (!directory || !isAbsolute(directory)) throw new Error("MUNDUSX_MEDIA_DIR must be an absolute persistent-volume path");
    this.pool = pool;
    this.directory = resolve(directory);
    this.now = now;
    this.activeUploads = 0;
    this.cleaning = false;
  }

  async transaction(action) {
    if (!this.pool) throw httpError(503, "PostgreSQL media storage is unavailable");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await action(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  file(id, contentType = "image/png") {
    if (!UUID.test(id ?? "")) throw notFound();
    return join(this.directory, `${id}.${contentType === "video/mp4" ? "mp4" : "png"}`);
  }

  async reserve(owner, input) {
    const metadata = validateMetadata(input);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const capacity = await statfs(this.directory);
    if (capacity.bavail * capacity.bsize < 512 * 1024 * 1024 + metadata.byte_size) {
      throw httpError(507, "Insufficient media storage space");
    }
    const id = randomUUID(), uploadToken = randomBytes(32).toString("hex"), downloadToken = randomBytes(32).toString("hex");
    const now = new Date(this.now()), expires = new Date(this.now() + UPLOAD_SECONDS * 1000);
    await this.transaction(async (client) => {
      // Serialize per-user admission across replicas, rather than trusting a process-local counter.
      const user = await client.query("select id from public.users where id=$1 and status='active' for update", [owner]);
      if (!user.rows.length) throw httpError(401, "Current user is unavailable");
      const quota = await client.query(`select count(*)::int as count, coalesce(sum(byte_size),0)::bigint as bytes
        from public.media_artifacts where owner_user_id=$1 and expires_at > $2`, [owner, now]);
      if (quota.rows[0].count >= 64 || Number(quota.rows[0].bytes) + metadata.byte_size > 256 * 1024 * 1024) {
        throw httpError(429, "Image storage limit reached for this user");
      }
      await client.query(`insert into public.media_artifacts
        (artifact_id,owner_user_id,sha256,byte_size,width,height,upload_token_hash,download_token_hash,created_at,upload_expires_at,expires_at,content_type,frames,fps)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13)`,
      [id, owner, metadata.sha256, metadata.byte_size, metadata.width, metadata.height, hash(uploadToken), hash(downloadToken), now, expires, metadata.content_type ?? "image/png", metadata.frames ?? null, metadata.fps ?? null]);
    });
    const downloadPath = `/media/${id}/${metadata.content_type === "video/mp4" ? "video.mp4" : "image.png"}?token=${downloadToken}`;
    return { artifact_id: id, status: "pending", retention_seconds: RETENTION_SECONDS,
      download_path: downloadPath, preview_path: `${downloadPath}&inline=1`,
      upload_ticket: { version: 1, artifact_id: id, upload_path: `/api/media/artifacts/${id}/content`,
        upload_token: uploadToken, expires_at: expires.toISOString(), ...metadata } };
  }

  async lookup(id) {
    this.file(id);
    if (!this.pool) throw httpError(503, "PostgreSQL media storage is unavailable");
    const result = await this.pool.query("select * from public.media_artifacts where artifact_id=$1", [id]);
    if (!result.rows.length) throw notFound();
    return result.rows[0];
  }

  async owned(id, owner) {
    const row = await this.lookup(id);
    if (row.owner_user_id !== owner) throw notFound();
    return publicRecord(row, this.now());
  }

  async renewLink(id, owner) {
    this.file(id);
    const token = randomBytes(32).toString("hex");
    const result = await this.pool.query(`update public.media_artifacts set download_token_hash=$1
      where artifact_id=$2 and owner_user_id=$3 and status='ready' and expires_at > $4 returning *`,
    [hash(token), id, owner, new Date(this.now())]);
    if (!result.rows.length) throw notFound();
    const path = `/media/${id}/${result.rows[0].content_type === "video/mp4" ? "video.mp4" : "image.png"}?token=${token}`;
    return { ...publicRecord(result.rows[0], this.now()), download_path: path, preview_path: `${path}&inline=1` };
  }

  authorizeUpload(row, token) {
    if (!matches(token, row.upload_token_hash) || new Date(row.upload_expires_at).getTime() <= this.now() ||
        new Date(row.expires_at).getTime() <= this.now()) throw notFound();
  }

  async upload(id, token, bytes) {
    // HTTP admission reserves memory before reading bytes; also validate callers outside HTTP.
    const row = await this.lookup(id);
    this.authorizeUpload(row, token);
    if (bytes.length !== row.byte_size || hash(bytes) !== row.sha256) throw httpError(422, "Image size or checksum does not match the upload ticket");
    if (row.content_type !== "video/mp4") validatePng(bytes, row.width, row.height);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.upload-${id}-${randomBytes(16).toString("hex")}.tmp`);
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(bytes);
      await file.sync();
      await file.close(); file = null;
      if (row.content_type === "video/mp4") await validateVideo(temporary, row);
      return await this.transaction(async (client) => {
        const result = await client.query("select * from public.media_artifacts where artifact_id=$1 for update", [id]);
        if (!result.rows.length) throw notFound();
        const current = result.rows[0];
        this.authorizeUpload(current, token);
        if (current.status === "ready") return publicRecord(current, this.now()); // Retry cannot extend retention or overwrite bytes.
        await rename(temporary, this.file(id, row.content_type));
        const now = new Date(this.now()), expires = new Date(this.now() + RETENTION_SECONDS * 1000);
        const updated = await client.query(`update public.media_artifacts set status='ready', ready_at=$1, expires_at=$2
          where artifact_id=$3 returning *`, [now, expires, id]);
        return publicRecord(updated.rows[0], this.now());
      });
    } finally {
      await file?.close().catch(() => {});
      await unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; });
    }
  }

  async download(id, token) {
    const row = await this.lookup(id);
    if (row.status !== "ready" || !matches(token, row.download_token_hash) || new Date(row.expires_at).getTime() <= this.now()) throw notFound();
    let file;
    try {
      file = await open(this.file(id, row.content_type), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size !== row.byte_size) throw notFound();
      return { file, record: publicRecord(row, this.now()) };
    } catch (error) { await file?.close(); if (error.code === "ENOENT" || error.code === "ELOOP") throw notFound(); throw error; }
  }

  async cleanup() {
    if (this.cleaning) return 0;
    this.cleaning = true;
    try {
      // Row locks prevent cleanup racing a final upload/commit, including across processes.
      const removed = await this.transaction(async (client) => {
        const result = await client.query(`select artifact_id,content_type from public.media_artifacts
          where expires_at <= $1 and file_deleted_at is null order by expires_at limit 100 for update skip locked`, [new Date(this.now())]);
        for (const row of result.rows) {
          await unlink(this.file(row.artifact_id, row.content_type)).catch((e) => { if (e.code !== "ENOENT") throw e; });
          await client.query(`update public.media_artifacts set file_deleted_at=$2,
            upload_token_hash=repeat('0',64),download_token_hash=repeat('0',64) where artifact_id=$1`,
          [row.artifact_id, new Date(this.now())]);
        }
        return result.rows.length;
      });
      // Only our strictly named temporary files, abandoned longer than the upload deadline.
      for (const name of await readdir(this.directory).catch((e) => { if (e.code === "ENOENT") return []; throw e; })) {
        if (!/^\.upload-[0-9a-f-]{36}-[0-9a-f]{32}\.tmp$/.test(name)) continue;
        const path = join(this.directory, name);
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < this.now() - 2 * UPLOAD_SECONDS * 1000) await unlink(path).catch(() => {});
      }
      return removed;
    } finally { this.cleaning = false; }
  }
}
