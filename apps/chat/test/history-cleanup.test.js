import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const cleanup = source.slice(source.indexOf('    async function retainRestorableHistory('), source.indexOf('    function readHistory()'));
test('history cleanup removes empty entries but preserves saved, cached, active and unavailable conversations', async () => {
 const removed=[]; const calls=[];
 const context={readCachedConversation:id=>id==='cached'?[{content:'hello'}]:[], conversationStreamStates:new Map([['active',{}]]), localStorage:{removeItem:key=>removed.push(key)},conversationCachePrefix:'cache:',fetchConversationMessages:async id=>{calls.push(id);if(id==='outage')throw new Error('offline');return id==='saved'?[{content:'hello'}]:[];}};
 const run=runInNewContext(cleanup+'; retainRestorableHistory',context);
 const result=await run(['empty','saved','cached','active','outage'].map(id=>({id})));
 assert.deepEqual(Array.from(result,item=>item.id),['saved','cached','active','outage']);
 assert.deepEqual(removed,['cache:empty']);assert.ok(!calls.includes('cached'));assert.ok(!calls.includes('active'));
});
test('a message arriving while cleanup checks the backend preserves the conversation', async()=>{
 let cached=[];const removed=[];
 const run=runInNewContext(cleanup+'; retainRestorableHistory',{readCachedConversation:()=>cached,conversationStreamStates:new Map(),localStorage:{removeItem:key=>removed.push(key)},conversationCachePrefix:'cache:',fetchConversationMessages:async()=>{cached=[{content:'new message'}];return []}});
 assert.equal((await run([{id:'new'}])).length,1);assert.equal(removed.length,0);
});
test('unavailable history throws instead of being classified as empty', async()=>{
 const start=source.indexOf('    async function fetchConversationMessages(');
 const fn=source.slice(start,source.indexOf('    function renderStoredTurn(',start));
 const run=runInNewContext(fn+'; fetchConversationMessages',{fetch:async()=>({ok:true,json:async()=>({messages:[],persisted:false,unavailable:true})})});
 await assert.rejects(()=>run('existing'),/conversation unavailable/);
});
