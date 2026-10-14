import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installMediaChatUi} from '../src/features/media/chat-ui.js';

test('stale queue positions clear on failed polls and missing requests become terminal',async()=>{
  for(const failure of [503,404]) {
    const timers=[],elements=[];
    function element(tag){const node={tag,isConnected:true,children:[],style:{},textContent:'',classList:{add(){} ,remove(){}},setAttribute(){},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items},querySelector(){return null}};elements.push(node);return node;}
    const body=element('body'),node=element('article');node.querySelector=()=>body;
    let calls=0;
    const sandbox={AbortController,AbortSignal,WeakMap,Date,Math,Number,JSON,Error,encodeURIComponent,
      document:{createElement:element,createElementNS:(_,tag)=>element(tag)},
      setTimeout:callback=>timers.push(callback),
      fetch:async()=>++calls===1?{ok:true,json:async()=>({state:'queued',worker_availability:'offline',queue_position:2,jobs_ahead:1,pending_requests:1})}:{ok:false,status:failure,json:async()=>({error:'Server unavailable'})}};
    vm.createContext(sandbox);
    const install=vm.runInContext('('+installMediaChatUi.toString()+')',sandbox);
    install({identity:()=> 'owner',activeConversation:()=> 'chat',cache(){},scroll(){}}).restore(node,{job_id:'job',kind:'image'},'chat');
    await new Promise(resolve=>setImmediate(resolve));
    const status=elements.find(item=>item.className==='media-chat-status');
    const queue=elements.filter(item=>item.className==='media-chat-queue')[0];
    assert.match(status.textContent,/come online/);
    assert.match(queue.textContent,/position: 2/);
    timers.shift()();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(queue.textContent,'');
    const heading=elements.find(item=>item.tag==='strong');
    assert.equal(heading.textContent,failure===404?'Request no longer available':'Status unavailable');
    assert.equal(timers.length,failure===404?0:1);
  }
});
