function startControlPlaneLiveStatus(env = globalThis) {
  const { document } = env;
  const selector = '[data-live-key], a.metric-link';
  if (!document.querySelectorAll(selector).length) return null;
  const notice = document.createElement('div');
  notice.className = 'meta';
  notice.setAttribute('role', 'status');
  notice.textContent = 'Updating live status…';
  document.querySelector('main').prepend(notice);
  let timer;
  let stopped = false;
  let pending = false;
  const key = node => node.getAttribute('data-live-key') || node.getAttribute('href');
  async function refresh() {
    if (stopped || pending) return;
    env.clearTimeout(timer);
    if (document.hidden) { timer = env.setTimeout(refresh, 2000); return; }
    pending = true;
    try {
      // One server render supplies both totals and node occupancy from the
      // same state. Keep filters/page, user controls, focus and scroll intact.
      const response = await env.fetch(env.location.href, {
        credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'text/html' }, signal: env.AbortSignal.timeout(10000),
      });
      if (!response.ok || response.redirected) throw new Error('Status unavailable');
      const html = await response.text();
      if (stopped) return;
      const next = new env.DOMParser().parseFromString(html, 'text/html');
      const replacements = new Map([...next.querySelectorAll(selector)].map(node => [key(node), node]));
      const current = [...document.querySelectorAll(selector)];
      if (current.some(node => !replacements.has(key(node)))) throw new Error('Status snapshot incomplete');
      for (const node of current) {
        const replacement = replacements.get(key(node));
        if (node.innerHTML !== replacement.innerHTML) node.innerHTML = replacement.innerHTML;
      }
      notice.textContent = 'Live status · updated ' + new Date().toLocaleTimeString();
    } catch (_) {
      if (!stopped) notice.textContent = 'Status may be stale · retrying connection…';
    } finally {
      pending = false;
      if (!stopped) timer = env.setTimeout(refresh, 2000);
    }
  }
  document.addEventListener('visibilitychange', refresh);
  function stop() {
    stopped = true;
    env.clearTimeout(timer);
    document.removeEventListener('visibilitychange', refresh);
  }
  env.addEventListener('pagehide', stop, { once: true });
  refresh();
  return { refresh, stop };
}

if (typeof window !== 'undefined') startControlPlaneLiveStatus(window);
