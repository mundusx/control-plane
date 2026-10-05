import { httpError } from '../../shared/http-error.js';

// Heartbeats update live control-plane state; the devices table is a snapshot.
export function mediaAdmission(config, fetchImpl = fetch, now = Date.now) {
  return async (device, profiles) => {
    let response;
    try {
      response = await fetchImpl(`${config.controlPlaneUrl}/v1/nodes?page=1&page_size=25&search=${encodeURIComponent(device.node_id)}`, {
        headers: { Accept: 'application/json', ...(config.operatorToken ? { Authorization: `Bearer ${config.operatorToken}` } : {}) },
        signal: AbortSignal.timeout(8000), redirect: 'error',
      });
    } catch { throw httpError(503, 'Contributor admission is temporarily unavailable'); }
    if (!response.ok) throw httpError(503, 'Contributor admission is temporarily unavailable');
    const payload = await response.json();
    const nodes = Array.isArray(payload) ? payload : payload.items;
    const node = Array.isArray(nodes) ? nodes.find(n => n.node_id === device.node_id) : null;
    const age = now() / 1000 - Number(node?.updated_at);
    const health = node?.worker_health;
    const mediaAllowed = health?.runtime_mode !== 'media' ||
      (Array.isArray(profiles) && profiles.length > 0 && profiles.every(profile => health.media_profiles?.includes(profile)));
    return mediaAllowed && !!node && node.public_key_hex === device.public_key_hex && node.policy_allowed === true &&
      ['ready', 'busy'].includes(node.state) && Number.isFinite(age) && age >= -120 && age <= 60;
  };
}
