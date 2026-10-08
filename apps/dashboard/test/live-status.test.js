import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../control-plane/src/live-status.js', import.meta.url), 'utf8');
const start = runInNewContext(source + '\nstartControlPlaneLiveStatus;', {});
const flush = () => new Promise(resolve => setImmediate(resolve));
const element = (key, innerHTML) => ({ innerHTML, getAttribute: name => name === 'data-live-key' ? key : null });

test('credits, requests and generated tokens keep distinct live values', async () => {
  const markup = readFileSync(new URL('../../control-plane/src/main.rs', import.meta.url), 'utf8');
  for (const key of ['credits-total', 'total-requests', 'generated-tokens']) {
    assert.ok(markup.includes(`data-live-key="${key}"`));
  }
  const f = fixture();
  f.nodes.splice(0, 2, element('credits-total', '12.50'), element('total-requests', '2'), element('generated-tokens', '1000'));
  f.setIncoming([element('credits-total', '18.75'), element('total-requests', '3'), element('generated-tokens', '19056')]);
  const controller = start(f.env); await flush();
  assert.deepEqual(f.nodes.map(node => node.innerHTML), ['18.75', '3', '19056']);
  await controller.refresh();
  assert.deepEqual(f.nodes.map(node => node.innerHTML), ['18.75', '3', '19056']);
  controller.stop();
});

function fixture() {
  const nodes = [element('node-state-worker', '1/16 active Â· 15 free'), element('assigned', '1')];
  let incoming = [element('node-state-worker', '3/16 active Â· 13 free'), element('assigned', '3')];
  let fail = false;
  const notices = []; const calls = []; const timers = [];
  const document = { hidden: false, querySelectorAll: () => nodes,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    querySelector: () => ({ prepend: notice => notices.push(notice) }),
    addEventListener() {}, removeEventListener() {},
  };
  const env = { document, location: { href: 'https://control.test/nodes?state=busy&page=2' },
    AbortSignal, addEventListener() {}, clearTimeout() {}, setTimeout: fn => timers.push(fn),
    fetch: async (url, options) => { calls.push({ url, options }); if (fail) throw new Error('offline'); return { ok: true, text: async () => 'snapshot' }; },
    DOMParser: class { parseFromString() { return { querySelectorAll: () => incoming }; } },
  };
  return { env, nodes, notices, calls, timers, setIncoming: value => { incoming = value; }, fail: () => { fail = true; } };
}

test('one snapshot updates both three assigned jobs and three occupied slots without reload', async () => {
  const f = fixture(); const controller = start(f.env); await flush();
  assert.equal(f.nodes[0].innerHTML, '3/16 active Â· 13 free');
  assert.equal(f.nodes[1].innerHTML, '3');
  assert.equal(f.calls[0].url, f.env.location.href);
  assert.equal(f.calls[0].options.cache, 'no-store');
  f.setIncoming([element('node-state-worker', '0/16 active Â· 16 free'), element('assigned', '0')]);
  await controller.refresh();
  assert.equal(f.nodes[0].innerHTML, '0/16 active Â· 16 free');
  assert.equal(f.nodes[1].innerHTML, '0');
  controller.stop();
});

test('failed or incomplete snapshots preserve counts and explicitly mark them stale', async () => {
  const f = fixture(); const controller = start(f.env); await flush();
  f.setIncoming([element('assigned', '0')]); await controller.refresh();
  assert.equal(f.nodes[1].innerHTML, '3');
  assert.match(f.notices[0].textContent, /stale/);
  f.fail(); await controller.refresh();
  assert.equal(f.nodes[0].innerHTML, '3/16 active Â· 13 free');
  assert.match(f.notices[0].textContent, /stale/);
  controller.stop();
});

test('hidden and stopped pages do not keep fetching', async () => {
  const f = fixture(); f.env.document.hidden = true;
  const controller = start(f.env); await flush();
  assert.equal(f.calls.length, 0);
  f.env.document.hidden = false; await controller.refresh();
  assert.equal(f.calls.length, 1);
  controller.stop(); await controller.refresh();
  assert.equal(f.calls.length, 1);
});
