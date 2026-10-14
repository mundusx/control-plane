import { IMAGE_PROFILE, ACTIVE_VIDEO_PROFILES, ACTIVE_I2V_PROFILES, mediaQuote } from './pricing.js';
import { httpError } from '../../shared/http-error.js';

export function videoQuality(input) {
  if (input.quality !== undefined) {
    if (!['fast','quality'].includes(input.quality)) throw httpError(400,'Video quality must be fast or quality');
    return input.quality;
  }
  const text = String(input.prompt || '').replace(/\b(?:no|not|without|don't need|do not need)\s+(?:hd|uhd|4k|8k|high quality|best quality)\b/gi,'');
  return /\b(?:hd|uhd|4k|8k|high(?:est)?[- ](?:definition|quality|resolution)|best[- ](?:definition|quality|resolution)|maximum[- ]quality)\b/i.test(text) ? 'quality' : 'fast';
}

// Shared contract for MCP and HTTP actions. Never wait for GPU work in a request.
export class MediaClientService {
  constructor(queue, publicOrigin, planner = null) {
    this.queue = queue;
    this.origin = publicOrigin ? new URL(publicOrigin).origin : null;
    this.planner = planner;
  }
  profiles() {
    return { profiles: [IMAGE_PROFILE, ...ACTIVE_VIDEO_PROFILES, ...ACTIVE_I2V_PROFILES].map(mediaQuote),
      file_retention_seconds: 172800, asynchronous: true };
  }
  async submit(owner, input) {
    if (!this.queue || !this.origin) throw httpError(503, 'Media generation is not configured');
    if (!input || !['image', 'video'].includes(input.kind)) throw httpError(400, 'kind must be image or video');
    let profile = IMAGE_PROFILE;
    if (input.kind === 'video') {
      const seconds = input.duration_seconds ?? 3;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) throw httpError(400, 'Videos are limited to 10 seconds maximum. Please choose a whole-number duration from 1 to 10 seconds.');
      input = {...input,quality:videoQuality(input)};
      const fast = input.quality === 'fast';
      const prefix = input.input_artifact_id ? (fast ? 'wan22-i2v-lightning-14b' : 'wan22-i2v-14b') : (fast ? 'wan22-t2v-lightning-14b' : 'wan22-14b');
      profile = `${prefix}-480p-${seconds * 16 + 1}f-${input.input_artifact_id && fast ? 'v3' : 'v1'}`;
    } else if (input.duration_seconds !== undefined) throw httpError(400, 'duration_seconds applies only to video');
    if (this.planner) {
      const plan = await this.planner(input);
      if (plan.profile_id !== profile) throw httpError(503,'Media planner profile does not match the supported request');
    }
    const job = await this.queue.submit(owner, { profile_id: profile, prompt: input.prompt,
      seed: input.seed, input_artifact_id: input.input_artifact_id, idempotency_key: input.idempotency_key });
    return this.describe(job);
  }
  describe(job) {
    return { ...job, status_url: `${this.origin}/v1/media/jobs/${job.job_id}`,
      terminal: ['completed', 'failed', 'cancelled'].includes(job.state),
      poll_after_seconds: ['queued', 'running'].includes(job.state) ? 30 : null,
      next_action: job.state === 'completed' ? 'get_media_result' :
        ['queued', 'running'].includes(job.state) ? 'check_job_status' : 'report_failure' };
  }
  async status(owner, id) {
    if (!this.queue || !this.origin) throw httpError(503, 'Media generation is not configured');
    return this.describe(await this.queue.owned(owner, id));
  }
  async cancel(owner,id) {
    if (!this.queue) throw httpError(503,'Media generation is not configured');
    return this.queue.cancel(owner,id);
  }
  async result(owner, id, { ownerOnly = false } = {}) {
    const job = await this.status(owner, id);
    if (job.state !== 'completed') throw httpError(409, 'Media is not completed; check job status first');
    if (!job.artifact?.media_available) throw httpError(410, 'Media expired; job and credit records are retained');
    if (ownerOnly) {
      const path = `/media/owned/${job.artifact_id}/${job.artifact.content_type === 'video/mp4' ? 'video.mp4' : 'image.png'}`;
      return { job_id: id, state: job.state, content_type: job.artifact.content_type,
        download_url: path, preview_url: path + '?inline=1', expires_at: job.artifact.expires_at,
        quote: job.quote, note: 'Sign-in required; available only to the requesting account until expiry.' };
    }
    const link = await this.queue.store.renewLink(job.artifact_id, owner);
    return { job_id: id, state: job.state, content_type: link.content_type,
      download_url: new URL(link.download_path, this.origin).href,
      preview_url: new URL(link.preview_path, this.origin).href,
      expires_at: link.expires_at, quote: job.quote,
      note: 'Anyone with this link can download until expiry. Creating another result link replaces the previous link.' };
  }
}
