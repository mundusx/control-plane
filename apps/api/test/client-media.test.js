const test=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const {clientMediaRoute,mediaHeaders}=require('../src/client-media');const {createApi}=require('../src/server');
const tools=[{type:'function',function:{name:'run_in_terminal',parameters:{type:'object',properties:{command:{type:'string'}}}}}];
const body=text=>({model:'mundusx-agnostic',tools,messages:[{role:'user',content:`<context>Editor data</context><userRequest>${text}</userRequest>`}]});
test('ambiguous creation and format replies route together, unrelated PNG stays normal',()=>{
 const {MEDIA_TYPE_QUESTION}=require('../src/client-clarification');
 assert.equal(clientMediaRoute(body('create walking cat with hat')),true);
 assert.equal(clientMediaRoute(body('create garfiled cat in nija custom')),true);
 assert.equal(clientMediaRoute(body('PNG')),false);
 const pending={...body('PNG'),messages:[...body('create walking cat with hat').messages,{role:'assistant',content:MEDIA_TYPE_QUESTION},...body('PNG').messages]};
 assert.equal(clientMediaRoute(pending),true);
 assert.equal(clientMediaRoute({...pending,messages:[...pending.messages.slice(0,-1),...body('hello').messages]}),false);
 assert.equal(clientMediaRoute(body('create a cat component')),false);
});
test('only explicit image work and its own save acknowledgements use the optional route',()=>{
 assert.equal(clientMediaRoute(body('Generate an image of blue mountains')),true);
 for(const text of ['Hello','How do I generate an image?','Write code to generate an image','Do not create an image','Create a video of a cat'])assert.equal(clientMediaRoute(body(text)),false,text);
 assert.equal(clientMediaRoute({...body('Create an image'),tools:[]}),false);
 assert.equal(clientMediaRoute({...body('Create an image'),tool_choice:'none'}),false);
 assert.equal(clientMediaRoute({messages:[{role:'tool',tool_call_id:'ordinary_call'}]}),false);
 assert.equal(clientMediaRoute({messages:[{role:'tool',tool_call_id:'call_ehda_image_save_'+'0'.repeat(32)}]}),true);
});
test('gateway keeps normal chat on the old upstream and signs only image forwarding',async t=>{
 const hits=[];const listen=async handler=>{const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close()});return 'http://127.0.0.1:'+s.address().port};
 const upstream=name=>async(req,res)=>{let raw='';for await(const c of req)raw+=c;hits.push({name,headers:req.headers,raw});res.setHeader('Content-Type','application/json');res.end('{"choices":[{"message":{"content":"ok"}}]}')};
 const normal=await listen(upstream('normal')),image=await listen(upstream('image'));
 const gateway=createApi({upstreamUrl:normal,mediaUpstreamUrl:image,upstreamToken:'test-server-secret',authenticate:k=>k==='existing-client-key'?{id:'owner',user:'OWNER'}:null,recordUsage:()=>{}});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>{gateway.closeAllConnections();gateway.close()});
 for(const text of ['Hello','Generate an image of blue mountains']) {
  const r=await fetch('http://127.0.0.1:'+gateway.address().port+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer existing-client-key','Content-Type':'application/json','x-mundusx-image-key-id':'spoof'},body:JSON.stringify(body(text))});assert.equal(r.status,200);await r.text();
 }
 assert.equal(hits[0].name,'normal');assert.equal(hits[0].headers['x-mundusx-image-key-id'],undefined);
 const actual=hits[1];assert.equal(actual.name,'image');assert.equal(actual.headers.authorization,'Bearer test-server-secret');assert.equal(actual.headers['x-mundusx-image-key-id'],'owner');
 const expected=mediaHeaders({id:'owner'},actual.raw,'test-server-secret',Number(actual.headers['x-mundusx-image-timestamp']));
 assert.equal(actual.headers['x-mundusx-image-signature'],expected['x-mundusx-image-signature']);
});
