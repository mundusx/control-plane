export function projectComputeAvailability(nodes,now=Date.now()) {
 let eligible=0,free=0;
 for(const node of nodes||[]){
  const updated=Number(node.updated_at||node.last_seen_at||node.worker_health?.checked_at);const age=now/1000-updated;
  if(!Number.isFinite(age)||age>60||age< -120||node.policy_allowed===false||!['ready','online','busy','saturated'].includes(node.state))continue;
  const health=node.worker_health||{},caps=node.capabilities||{};
  const tools=[...(caps.supported_tools||[]),...(health.capabilities?.supported_tools||[])];
  if(!tools.includes('native_tool_calls_v1')||health.healthy===false||caps.ready_for_jobs===false)continue;
  eligible++;const slots=Number(caps.parallel_slots||health.parallel_slots||1);const active=Number(caps.active_jobs||node.active_jobs||0);
  free+=['busy','saturated'].includes(node.state)?0:Math.max(0,slots-active);
 }
 return {state:eligible===0?'unavailable':free>0?'available':'busy',eligible_nodes:eligible,free_slots:free,checked_at:new Date(now).toISOString()};
}
