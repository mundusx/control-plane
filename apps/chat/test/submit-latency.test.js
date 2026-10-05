import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {page,configFromEnv,extractWeatherLocation,streamChatTurn} from '../src/main.js';
import {mayNeedMediaClassification,mediaChatIntent} from '../src/features/media/chat-intent.js';
import {resolveMediaIntent} from '../src/features/media/intent-resolver.js';

test('ordinary text and weather do not enqueue a media classifier job',async()=>{
  let calls=0;
  for (const message of ['whats the weather today in stuggi?','Hello','Write a Node.js CRUD API','Explain this image']) {
    assert.equal(mayNeedMediaClassification(message),false);
    assert.equal(await resolveMediaIntent(message,async()=>{calls++;return null;}),null);
  }
  assert.equal(calls,0);
  assert.equal(mayNeedMediaClassification('Tengeneza video ya paka'),true);
});

test('rendered submit handler shows and clears input before a slow classifier and prevents duplicate submits',async()=>{
  const html=page(configFromEnv({}));
  const start=html.indexOf('form.addEventListener("submit", async (event) => {');
  const end=html.indexOf('    async function runActiveProjectTask',start);
  assert.ok(start>0 && end>start);
  let handler, resolve, calls=0;
  const shown=[];
  const context={
    form:{addEventListener:(name,fn)=>handler=fn},
    promptEl:{value:"I'd like an image of a cat",focus(){}},sendEl:{disabled:false},currentUser:{id:'owner'},
    mediaChatIntent,mayNeedMediaClassification,
    projectSelectedForSubmission:()=>null,getConversationId:()=> 'conversation',readCachedConversation:()=>[],
    activeHistoryLoadToken:0,followLatestMessage:false,saveHistory(){},appendCachedConversationTurn(){},setStatus(){},
    addMessage:(message,role)=>{shown.push({message,role});return {};},
    fetch:()=>{calls++;return new Promise(r=>resolve=r);},
    tryLiveChatTurn:async()=>{},syncNetworkRuntimeStatus(){},
    recoverInterruptedConversationStream:async()=>false,failConversationStream:(id,pending,message,error)=>{throw error;},
  };
  vm.runInNewContext(html.slice(start,end),context);
  const work=handler({preventDefault(){}});
  assert.equal(shown[0].role,'user');assert.equal(shown.length,2);
  assert.equal(context.promptEl.value,'');assert.equal(context.sendEl.disabled,true);assert.equal(calls,1);
  context.promptEl.value='Another message';await handler({preventDefault(){}});assert.equal(calls,1);
  resolve({ok:true,json:async()=>({intent:null})});await work;
  assert.equal(context.sendEl.disabled,false);
});

test('Stuggi is normalized and failed direct weather lookup never falls back to an LLM',async()=>{
  assert.equal(extractWeatherLocation('whats the weather today in stuggi?'),'Stuttgart');
  let requests=0;
  await assert.rejects(streamChatTurn({}, {message:'whats the weather today in stuggi?',toolMode:false},
    configFromEnv({MUNDUSX_CONTROL_PLANE_URL:'https://control.example'}),async url=>{
      requests++;assert.equal(url,'https://wttr.in/Stuttgart?format=j1');return new Response('',{status:503});
    }),{statusCode:503});
  assert.equal(requests,1);
});
