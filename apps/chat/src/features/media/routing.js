import { mediaFingerprint } from './qualification.js';
import { httpError } from '../../shared/http-error.js';

export function eligibleMediaNode(node, profile, now = Date.now()) {
  const health = node?.worker_health;
  const age = now / 1000 - Number(node?.updated_at);
  const qualified = !node?.trust?.qualification_required || !!node.media_qualifications?.some(q=>q.profile_id===profile&&q.state==='passed'&&q.fingerprint===mediaFingerprint(node,profile));
  return qualified && node?.policy_allowed === true && ['ready','busy'].includes(node.state)
    && Number.isFinite(age) && age >= -120 && age <= 60
    && health?.healthy === true && health.media_budget_bytes >= (profile==='dreamshaper-8-sd15-512-v1' ? 8 : profile.startsWith('qwen-') ? 24 : 64) * 1024 ** 3
    && health.media_profiles?.includes(profile);
}

// Short-lived live snapshots avoid one control-plane request per candidate.
export function mediaFleet(config, fetchImpl = fetch, now = Date.now, qualificationLookup = null) {
  let cached, expires = 0, pending;
  return async () => {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const nodes = [];
      for (let page = 1; page <= 100; page++) {
        let response;
        try {
          response = await fetchImpl(`${config.controlPlaneUrl}/v1/nodes?page=${page}&page_size=100`, {
            headers: {Accept:'application/json', ...(config.operatorToken ? {Authorization:`Bearer ${config.operatorToken}`} : {})},
            signal: AbortSignal.timeout(8000), redirect:'error',
          });
        } catch { throw httpError(503, 'Media contributor availability is temporarily unavailable'); }
        if (!response.ok) throw httpError(503, 'Media contributor availability is temporarily unavailable');
        const payload = await response.json(), items = Array.isArray(payload) ? payload : payload.items;
        if (!Array.isArray(items)) throw httpError(503, 'Invalid contributor availability response');
        nodes.push(...items);
        if (items.length < 100 || Array.isArray(payload)) break;
        if (page === 100) throw httpError(503, 'Contributor fleet exceeds routing snapshot limit');
      }
      if(qualificationLookup) {
        const results=await qualificationLookup();
        for(const node of nodes)node.media_qualifications=results.filter(q=>q.node_id===node.node_id);
      }
      cached = nodes; expires = now() + 3000; return nodes;
    })();
    try { return await pending; } finally { pending = null; }
  };
}

// Same-profile speed is telemetry, not output-quality evidence or billing input.
// Every fifth assignment explores the least recently served eligible worker.
export function rankMediaWorkers(candidates, profile, assignmentCount, now = Date.now()) {
  const ready = candidates.filter(n => n.profiles.includes(profile) && n.running === 0
    && now - new Date(n.last_poll_at).getTime() <= 45000);
  const fastest = Math.min(...ready.filter(n => n.completed >= 3 && n.mean_ms > 0).map(n => n.mean_ms));
  const score = n => {
    const reliability = (n.completed + 2) / (n.completed + n.failed + 4);
    const speed = n.completed >= 3 && Number.isFinite(fastest) && n.mean_ms > 0 ? Math.min(1, fastest / n.mean_ms) : 0.5;
    return 0.8 * reliability + 0.2 * speed;
  };
  const age = n => n.last_assigned_at ? new Date(n.last_assigned_at).getTime() : 0;
  return ready.sort((a,b) => assignmentCount % 5 === 4
    ? age(a) - age(b) || score(b) - score(a) || a.node_id.localeCompare(b.node_id)
    : score(b) - score(a) || age(a) - age(b) || a.node_id.localeCompare(b.node_id));
}

export async function rankedMediaWorker(db, fleet, profile, now) {
  const presence = (await db.query(`select p.*, count(a.*) filter(where a.state='completed')::int completed,
    count(a.*) filter(where a.state in ('failed','expired'))::int failed,
    avg(a.generation_ms) filter(where a.state='completed' and a.generation_ms>0) mean_ms,
    (select count(*)::int from public.media_generation_jobs q where q.node_id=p.node_id and q.state='running') running
    from public.media_worker_presence p left join public.media_execution_attempts a
      on a.node_id=p.node_id and a.profile_id=$1 and a.started_at>$2
    where p.last_poll_at>$3 group by p.node_id`, [profile,new Date(now-30*86400000),new Date(now-45000)])).rows;
  const live = new Map(fleet.filter(n => eligibleMediaNode(n,profile,now)).map(n => [n.node_id,n]));
  const candidates = presence.filter(n => live.get(n.node_id)?.public_key_hex === n.public_key_hex);
  const count = Number((await db.query('select assignments from public.media_routing_clock where profile_id=$1',[profile])).rows[0]?.assignments ?? 0);
  return rankMediaWorkers(candidates,profile,count,now)[0]?.node_id;
}
