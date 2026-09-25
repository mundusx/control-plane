import { randomUUID } from "node:crypto";
import { mediaQuote } from "./pricing.js";
import { httpError } from "../../shared/http-error.js";

// Called only by the trusted dispatcher, never by a contributor or browser.
// Jobs are owned by the existing control plane; this module does not schedule them.
export class MediaAccounting {
  constructor(store) { this.store = store; }

  async quoteJob({ job_id, owner_user_id, profile_id }) {
    const quote = mediaQuote(profile_id);
    return this.store.transaction(async (db) => {
      const job = (await db.query("select * from public.jobs where job_id=$1 for update", [job_id])).rows[0];
      if (!job || job.classification?.operation !== quote.operation || job.classification?.media_profile_id !== quote.profile_id) {
        throw httpError(409, "Expected a control-plane image job with the quoted profile");
      }
      const old = (await db.query("select * from public.media_compute_records where job_id=$1", [job_id])).rows[0];
      if (old) {
        if (old.owner_user_id !== owner_user_id || old.quote.profile_id !== quote.profile_id) throw httpError(409, "Job quote already belongs to a different request");
        return old;
      }
      if (!["queued", "media_queued"].includes(job.status)) throw httpError(409, "Quote must be recorded before execution");
      const user = await db.query("select id from public.users where id=$1 and status='active'", [owner_user_id]);
      if (!user.rows.length) throw httpError(404, "Requesting user is unavailable");
      return (await db.query(`insert into public.media_compute_records(job_id,owner_user_id,quote)
        values($1,$2,$3) returning *`, [job_id, owner_user_id, quote])).rows[0];
    });
  }

  async bindArtifact({ job_id, artifact_id, node_id }) {
    return this.store.transaction(async (db) => {
      const job = (await db.query("select * from public.jobs where job_id=$1 for update", [job_id])).rows[0];
      const record = (await db.query("select * from public.media_compute_records where job_id=$1 for update", [job_id])).rows[0];
      if (!job || !record || job.assigned_node_id !== node_id || !["assigned", "running", "media_running"].includes(job.status)) {
        throw httpError(409, "Image job is not assigned to this contributor");
      }
      const artifact = (await db.query("select * from public.media_artifacts where artifact_id=$1 for update", [artifact_id])).rows[0];
      if (!artifact || artifact.owner_user_id !== record.owner_user_id || artifact.width !== record.quote.width ||
          artifact.height !== record.quote.height || (record.quote.operation === "text_to_video" && (artifact.content_type !== "video/mp4" || artifact.frames !== record.quote.frames || artifact.fps !== record.quote.fps)) || artifact.status !== "pending" || new Date(artifact.expires_at).getTime() <= this.store.now()) {
        throw httpError(409, "Expected an unexpired pending image reservation for this job owner and profile");
      }
      if (record.artifact_id) {
        if (record.artifact_id !== artifact_id || record.node_id !== node_id) throw httpError(409, "Job output is already bound");
        return record;
      }
      return (await db.query(`update public.media_compute_records set artifact_id=$1,node_id=$2
        where job_id=$3 returning *`, [artifact_id, node_id, job_id])).rows[0];
    });
  }

  async settle({ job_id, generation_ms }) {
    if (!Number.isSafeInteger(generation_ms) || generation_ms < 0) throw httpError(400, "Expected generation_ms telemetry");
    return this.store.transaction(async (db) => {
      const job = (await db.query("select * from public.jobs where job_id=$1 for update", [job_id])).rows[0];
      const record = (await db.query("select * from public.media_compute_records where job_id=$1 for update", [job_id])).rows[0];
      if (!record) throw httpError(404, "Image computation quote not found");
      if (record.status === "settled") return record;
      if (!job || !["completed", "media_completed"].includes(job.status) || job.assigned_node_id !== record.node_id ||
          job.classification?.operation !== record.quote.operation || job.classification?.media_profile_id !== record.quote.profile_id) {
        throw httpError(409, "Only the assigned contributor's completed image job can earn credits");
      }
      const artifact = (await db.query("select * from public.media_artifacts where artifact_id=$1 for update", [record.artifact_id])).rows[0];
      if (!artifact || artifact.status !== "ready" || artifact.file_deleted_at || new Date(artifact.expires_at).getTime() <= this.store.now()) {
        throw httpError(409, "A validated, available image is required before settlement");
      }
      // Protect against the legacy text formula or another settlement paying this job.
      if ((await db.query("select id from public.credits_ledger where job_id=$1 and entry_type='job_reward'", [job_id])).rows.length) {
        throw httpError(409, "This job already has a reward; reconcile it before media settlement");
      }
      const id = randomUUID(), now = new Date(this.store.now());
      const metadata = { ...record.quote, work_type: record.quote.operation === "text_to_video" ? "video_generation" : "image_generation", reward_scope: "job", job_status: "completed",
        artifact_id: artifact.artifact_id, sha256: artifact.sha256, byte_size: artifact.byte_size,
        generation_ms, runtime_role: "telemetry_only", contribution_percent_role: "routing_budget_only" };
      await db.query(`insert into public.credits_ledger
        (id,device_id,job_id,entry_type,amount,currency,metadata,created_at)
        values($1,$2,$3,'job_reward',$4,'credits',$5,$6)`, [id, record.node_id, job_id, record.quote.contributor_reward_credits, metadata, now]);
      return (await db.query(`update public.media_compute_records set status='settled',ledger_id=$1,generation_ms=$2,settled_at=$3
        where job_id=$4 returning *`, [id, generation_ms, now, job_id])).rows[0];
    });
  }

  async owned(jobId, owner) {
    const result = await this.store.pool.query("select * from public.media_compute_records where job_id=$1 and owner_user_id=$2", [jobId, owner]);
    if (!result.rows.length) throw httpError(404, "Image computation not found");
    return result.rows[0];
  }
}
