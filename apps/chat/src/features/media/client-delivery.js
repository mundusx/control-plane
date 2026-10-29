import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mediaChatIntent } from './chat-intent.js';
import { httpError } from '../../shared/http-error.js';
import { activeImagePrompt, nativeImageSave, imageUrlCompletion } from './native-image-save.js';

// Inspect only the active user turn, never instructions quoted by tools/history.
export function clientImageRequest(body) {
  if (body?.tool_choice === 'none' || !Array.isArray(body?.tools)) return null;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.at(-1)?.role !== 'user') return null;
  const prompt = activeImagePrompt(body);
  const intent = mediaChatIntent(prompt);
  if (intent?.kind !== 'image' || intent.error || prompt.length > 4000) return null;
  const tools = body.tools.filter(t => t?.type === 'function' &&
    /^[\w.:-]{1,128}$/.test(t.function?.name ?? '') &&
    /(?:^|[_.:])(?:run_in_terminal|execute_command|run_command|command|bash|powershell|exec_command)$/i.test(t.function.name) &&
    Object.entries(t.function.parameters?.properties ?? {}).some(([key, schema]) =>
      /^(?:command|cmd|commandLine|command_line|script)$/i.test(key) && schema?.type === 'string'));
  if (!tools.length) return null;
  return { ...intent, client_delivery: { destination: 'workspace', tool_names: tools.map(t => t.function.name).slice(0, 32) } };
}

export function clientMediaOwners(raw) {
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, owner]) =>
    !/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof owner !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)))
    throw new Error('Invalid client media API-key owner bindings');
  return value;
}

function requestKey(owner, body) {
  const identity = typeof body.request_id === 'string' ? body.request_id : new Date().toISOString().slice(0,10);
  const bytes = createHash('sha256').update(owner).update(identity).update(JSON.stringify(body.messages)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// The server generates media only. The existing client owns every filesystem action.
export async function clientImageCompletion(body, { owner, service, wait = delay, signal, timeoutMs = 300000 }) {
  const intent = clientImageRequest(body);
  if (!intent) return null;
  if (!owner) throw httpError(403, 'Image generation needs an account-bound API key. Normal chat remains available.');
  signal?.throwIfAborted();
  const submitted = await service.submit(owner, { ...intent, idempotency_key: requestKey(owner, body) });
  const delivery = submitted.client_delivery;
  if (delivery?.action !== 'download_to_workspace' || delivery.execution_owner !== 'client')
    throw httpError(503, 'The media planner did not authorize client artifact delivery');
  let job = submitted;
  const deadline = Date.now() + timeoutMs;
  while (['queued', 'running'].includes(job.state)) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw httpError(504, `Image job ${job.job_id} is still pending; retry this same conversation to resume it.`);
    await wait(Math.min(3000, Math.max(1, deadline - Date.now())), undefined, { signal });
    job = await service.status(owner, submitted.job_id);
  }
  signal?.throwIfAborted();
  if (job.state !== 'completed') throw httpError(502, `Image generation ${job.state}; no file was saved.`);
  const artifact = await service.result(owner, submitted.job_id);
  if (artifact.content_type !== 'image/png' || !/^https:\/\//.test(artifact.download_url ?? ''))
    throw httpError(502, 'Image generation returned an invalid artifact');
  const handoff = {
    job_id: submitted.job_id, url: artifact.download_url, content_type: artifact.content_type,
    expires_at: artifact.expires_at, suggested_filename: 'generated-image.png', ...delivery,
  };
  const completion = nativeImageSave(body, handoff) ?? imageUrlCompletion(handoff);
  return { ...completion, mundusx: { ...completion.mundusx, media_artifact: handoff, file_saved: false } };
}
