import { httpError } from '../../shared/http-error.js';

export function mediaPlanner(url, fetchImpl = fetch) {
  if (!url) return null;
  return async input => {
    let response;
    try {
      response = await fetchImpl(url, {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({kind:input.kind,has_reference:!!input.input_artifact_id,
          ...(input.kind === 'video' ? {duration_seconds:input.duration_seconds ?? 3, quality:input.quality ?? 'fast'} : {})}),
        signal:AbortSignal.timeout(8000),redirect:'error'});
    } catch { throw httpError(503,'Media planning is temporarily unavailable'); }
    if (!response.ok) throw httpError(503,'Media planning is temporarily unavailable');
    const result = await response.json();
    if (result.execution_route !== 'media_queue' || result.asynchronous !== true || typeof result.profile_id !== 'string')
      throw httpError(503,'Media planner returned an invalid route');
    return result;
  };
}
