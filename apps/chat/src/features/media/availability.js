import {eligibleMediaNode} from './routing.js';

export function capabilityAvailability(nodes, presence = [], loads = [], now = Date.now()) {
  const polling=new Map(presence.map(p=>[p.node_id,p]));
  const active=new Map(loads.map(p=>[p.node_id,p]));
  const result=Object.fromEntries(['chat','image','video','image_to_video'].map(k=>[k,{nodes:0,free_slots:0,duration_seconds:[]}]));
  for (const node of nodes) {
    const age=now/1000-Number(node.updated_at);
    if (!node.policy_allowed || !['ready','busy'].includes(node.state) || !Number.isFinite(age) || age < -120 || age>60) continue;
    const load=active.get(node.node_id) ?? {};
    const qualifiedChat=!node.trust?.qualification_required || (node.trust.qualification?.tested_context_tokens>0 && node.trust.qualification.probes?.some(p=>p.kind==='chat'&&p.status==='passed'));
    if (qualifiedChat && node.capabilities?.ready_for_jobs === true && node.worker_health?.runtime_mode !== 'media') {
      result.chat.nodes++;
      result.chat.free_slots+=Math.max(0,Number(node.trust?.qualification_required ? 1 : node.capabilities.parallel_slots ?? 1)-Number(load.llm_running ?? 0));
    }
    const poll=polling.get(node.node_id);
    if (!poll || poll.public_key_hex !== node.public_key_hex) continue;
    const running=Number(load.media_running ?? 0);
    if (now-new Date(poll.last_poll_at).getTime()>45000 && running===0) continue;
    for (const kind of ['image','video','image_to_video']) {
      const profiles=(node.worker_health?.media_profiles ?? []).filter(p=>poll.profiles.includes(p)
        && eligibleMediaNode(node,p,now)
        && (kind==='image'?p.startsWith('qwen-image-'):kind==='image_to_video'?p.startsWith('wan22-i2v-'):p.startsWith('wan22-14b-')));
      if (!profiles.length) continue;
      result[kind].nodes++;
      result[kind].free_slots+=running?0:1;
      for (const profile of profiles) {
        const frames=profile.match(/-(\d+)f-/)?.[1];
        if (frames) result[kind].duration_seconds.push((Number(frames)-1)/16);
      }
    }
  }
  for (const value of Object.values(result)) {
    value.state=value.nodes===0?'unavailable':value.free_slots>0?'available':'busy';
    value.duration_seconds=[...new Set(value.duration_seconds)].sort((a,b)=>a-b);
  }
  return result;
}

export async function liveCapabilityAvailability(fleet, store, now = Date.now()) {
  const nodes=await fleet();
  const presence=store?(await store.pool.query('select node_id,public_key_hex,profiles,last_poll_at from public.media_worker_presence')).rows:[];
  const loads=store?(await store.pool.query(`select node_id,sum(media_running)::int media_running,sum(llm_running)::int llm_running from (
    select node_id,count(*)::int media_running,0 llm_running from public.media_generation_jobs where state='running' and lease_until>$1 group by node_id
    union all select assigned_node_id node_id,0 media_running,count(*)::int llm_running from public.jobs where status in ('assigned','running') and assigned_node_id is not null group by assigned_node_id
    ${process.env.MUNDUSX_MEDIA_QUALIFICATION_MODE==='gradual' ? "union all select node_id,count(*)::int media_running,0 llm_running from public.media_qualification_probes where state='running' and lease_until>$1 group by node_id" : ""}
    ) x group by node_id`,[new Date(now)])).rows:[];
  return capabilityAvailability(nodes,presence,loads,now);
}
