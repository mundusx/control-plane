import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaAdmission } from '../src/features/media/admission.js';

test('video claims use fresh live admission, identity and liveness, not stale device policy', async () => {
  const device={node_id:'node-1',public_key_hex:'abc',policy_allowed:false};
  let node={...device,policy_allowed:true,state:'ready',updated_at:'1000'};
  const check=mediaAdmission({controlPlaneUrl:'https://control.example'},async()=>({ok:true,json:async()=>({items:[node]})}),()=>1000000);
  assert.equal(await check(device),true);
  for(const changes of [{policy_allowed:false},{state:'paused'},{updated_at:'939'},{public_key_hex:'different'},{node_id:'another'}]) {
    const saved=node; node={...node,...changes}; assert.equal(await check(device),false); node=saved;
  }
});
test('admission fails closed on unavailable control plane', async()=>{
  const check=mediaAdmission({controlPlaneUrl:'https://control.example'},async()=>{throw Error('offline')});
  await assert.rejects(check({node_id:'node-1'}),{statusCode:503});
});
