import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { httpError } from '../../shared/http-error.js';
import { validatePng } from './png.js';

export const IMAGE_MODEL = 'Qwen/Qwen-Image';
export const VIDEO_MODEL = 'Wan-AI/Wan2.2-T2V-A14B';
export const I2V_MODEL = 'Wan-AI/Wan2.2-I2V-A14B-Lightning';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function videoObject(job) {
  return { id: job.job_id, object: 'video', model: job.quote.model,
    status: ({ running: 'in_progress', cancelled: 'failed' })[job.state] ?? job.state,
    progress: job.state === 'completed' ? 100 : 0,
    created_at: Math.floor(new Date(job.created_at ?? Date.now()).getTime() / 1000),
    completed_at: job.completed_at ? Math.floor(new Date(job.completed_at).getTime() / 1000) : null,
    seconds: String((job.quote.frames - 1) / job.quote.fps), size: `${job.quote.width}x${job.quote.height}`,
    error: job.state === 'failed' ? { code: 'generation_failed', message: job.error ?? 'Media generation failed' } : null };
}
async function readVideoRequest(request, readJsonBody) {
  if (!String(request.headers['content-type'] ?? '').startsWith('multipart/form-data')) return readJsonBody(request);
  const chunks = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > 34 * 1024 * 1024) throw httpError(413, 'Reference upload too large'); chunks.push(chunk); }
  const form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
  const input = {};
  for (const [key, value] of form) {
    if (Object.hasOwn(input, key)) throw httpError(400, 'Duplicate request field');
    if (typeof value === 'string') input[key] = value;
    else if (key === 'input_reference') input[key] = Buffer.from(await value.arrayBuffer());
    else throw httpError(400, 'Only input_reference accepts a file');
  }
  return input;
}
function allowed(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Expected a media request object');
  if (Object.keys(input).some(key => !fields.includes(key))) throw httpError(400, 'Unsupported media request option');
}
export async function saveReference(store, owner, reference) {
  if (!store) throw httpError(503, 'Media generation is not configured');
  if (!Buffer.isBuffer(reference) || reference.length < 33) throw httpError(400, 'Reference must be an uploaded PNG file');
  const width = reference.readUInt32BE(16), height = reference.readUInt32BE(20);
  validatePng(reference, width, height);
  const reserved = await store.reserve(owner, { content_type: 'image/png', width, height, byte_size: reference.length, sha256: createHash('sha256').update(reference).digest('hex') });
  await store.upload(reserved.artifact_id, reserved.upload_ticket.upload_token, reference);
  return reserved.artifact_id;
}
export function createOpenAiMediaHttpController({ service, authStore, readJsonBody, sendJson, wait = sleep, imageTimeoutMs = 1800000 }) {
  return async ({ request, response, url }) => {
    const models = url.pathname === '/v1/models' && request.method === 'GET';
    const image = url.pathname === '/v1/images/generations';
    const video = url.pathname.match(/^\/v1\/videos(?:\/([0-9a-f-]{36})(\/content)?)?$/);
    if (!image && !video && !models) return false;
    if (models && !String(request.headers.authorization ?? '').startsWith('Bearer mxmcp_')) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const session = await authStore.mcpSession?.(request);
      if (!session && models) return false;
      if (!session) throw httpError(401, 'A MundusX user access token is required');
      if (models) {
        sendJson(response, 200, { object:'list', data:[IMAGE_MODEL, VIDEO_MODEL, I2V_MODEL].map(id=>({id,object:'model',created:0,owned_by:'mundusx-media'})) });
        return true;
      }
      if (image && request.method === 'POST') {
        const input = await readJsonBody(request);
        allowed(input, ['model','prompt','n','size','response_format','user']);
        if (input.model && input.model !== IMAGE_MODEL || input.n !== undefined && input.n !== 1 || input.size && input.size !== '832x480' || input.response_format && !['url','b64_json'].includes(input.response_format)) throw httpError(400, 'Supported: Qwen/Qwen-Image, n=1, size=832x480, url or b64_json');
        const submitted = await service.submit(session.id, { kind: 'image', prompt: input.prompt, idempotency_key: request.headers['idempotency-key'] ?? randomUUID() });
        response.setHeader('X-MundusX-Job-Id', submitted.job_id);
        const deadline = Date.now() + imageTimeoutMs;
        let job = submitted;
        while (['queued','running'].includes(job.state)) {
          if (response.destroyed) return true;
          if (Date.now() >= deadline) throw httpError(504, 'Image is still pending; retrieve X-MundusX-Job-Id through /v1/media/jobs');
          await wait(1000); job = await service.status(session.id, submitted.job_id);
        }
        if (job.state !== 'completed') throw httpError(502, 'Image generation failed');
        let item;
        if (input.response_format === 'b64_json') {
          if (!job.artifact?.media_available) throw httpError(410, 'Image expired');
          const bytes = await readFile(service.queue.store.file(job.artifact_id, 'image/png'));
          item = { b64_json: bytes.toString('base64') };
        } else item = { url: (await service.result(session.id, job.job_id)).download_url };
        sendJson(response, 200, { created: Math.floor(Date.now()/1000), data: [item] });
      } else if (video && !video[1] && request.method === 'POST') {
        const input = await readVideoRequest(request, readJsonBody);
        allowed(input, ['model','prompt','seconds','size','input_reference']);
        const seconds = Number(input.seconds ?? 3);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) throw httpError(400, 'Videos are limited to 10 seconds maximum. Please choose a whole-number duration from 1 to 10 seconds.');
        if (input.size && input.size !== '832x480') throw httpError(400, 'Supported video size: 832x480');
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) throw httpError(400, 'Expected a prompt of 1-4000 characters');
        const reference = input.input_reference;
        const model = reference ? I2V_MODEL : VIDEO_MODEL;
        if (input.model && input.model !== model) throw httpError(400, `Supported model for this request: ${model}`);
        let artifact;
        if (reference !== undefined) {
          artifact = await saveReference(service.queue?.store, session.id, reference);
        }
        const job = await service.submit(session.id, { kind: 'video', prompt: input.prompt, duration_seconds: seconds,
          input_artifact_id: artifact, idempotency_key: request.headers['idempotency-key'] ?? randomUUID() });
        response.setHeader('Location', `/v1/videos/${job.job_id}`);
        sendJson(response, 200, videoObject(job));
      } else if (video?.[1] && request.method === 'GET') {
        const job = await service.status(session.id, video[1]);
        if (!['text_to_video','image_to_video'].includes(job.quote.operation)) throw httpError(404, 'Video not found');
        if (!video[2]) sendJson(response, 200, videoObject(job));
        else {
          if (job.state !== 'completed') throw httpError(409, 'Video is not completed');
          if (!job.artifact?.media_available) throw httpError(410, 'Video expired');
          if (url.searchParams.get('variant') && url.searchParams.get('variant') !== 'video') throw httpError(400, 'Only video content is supported');
          const bytes = await readFile(service.queue.store.file(job.artifact_id, 'video/mp4'));
          response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); response.end(bytes);
        }
      } else throw httpError(405, 'Method not allowed');
    } catch (error) {
      if (response.headersSent) throw error;
      sendJson(response, error.statusCode ?? 500, { error: { message: error.statusCode ? error.message : 'Media service failed', type: error.statusCode === 401 ? 'authentication_error' : 'invalid_request_error', param: null, code: String(error.statusCode ?? 500) } });
    }
    return true;
  };
}
