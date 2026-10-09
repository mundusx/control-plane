import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCoding,runProgram} from '../src/features/qualification/coding.js';
import {codingQualificationController} from '../src/features/qualification/http.js';
const medium=`function solve(values){const out=[];for(const v of values){if(!out.includes(v))out.push(v);}out.sort((a,b)=>a-b);return out;}`;
const large=`function solve(input){const intervals=input.intervals.map(x=>x.slice());intervals.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const merged=[];for(const p of intervals){const last=merged[merged.length-1];if(last&&p[0]<=last[1])last[1]=Math.max(last[1],p[1]);else merged.push(p);}const remain=input.nodes.slice();const order=[];while(remain.length){const ready=[];for(const n of remain){let blocked=false;for(const e of input.edges){if(e[1]===n&&remain.includes(e[0]))blocked=true;}if(!blocked)ready.push(n);}if(!ready.length)return {intervals:merged,order:null};ready.sort((a,b)=>a-b);const n=ready[0];order.push(n);const next=remain.filter(x=>x!==n);remain.length;while(remain.length)remain.pop();for(const x of next)remain.push(x);}return {intervals:merged,order:order};}`;
test('medium and large suites execute correct algorithms and reject plausible broken code',()=>{
  assert.equal(evaluateCoding({level:'coding_medium',source:medium}).passed,true);
  assert.equal(evaluateCoding({level:'coding_medium',source:'function solve(values){const unique={};for(let i=0;i<values.length;i++)unique[values[i]]=true;return Object.keys(unique).map(Number).sort((a,b)=>a-b);}'}).passed,true);
  assert.equal(evaluateCoding({level:'coding_large',source:large}).passed,true);
  assert.equal(evaluateCoding({level:'coding_medium',source:'function solve(v){return v.sort((a,b)=>a-b);}'}).passed,false);
  assert.equal(evaluateCoding({level:'coding_large',source:large.replace('p[0]<=last[1]','p[0]<last[1]')}).passed,false);
});
test('host access, code generation, infinite loops, recursion, cyclic and explosive outputs fail closed',()=>{
  for(const source of ['function solve(x){return process.env;}','function solve(x){return [].constructor.constructor("return process")();}',
    'function solve(x){while(true){}}','function solve(x){return solve(x);}',
    'function solve(x){let a=[];a.push(a);return a;}',
    'function solve(x){let a=[0];for(let i=0;i<64;i++)a=[a,a];return a;}',
    'function solve(x){return eval("1");}', 'function solve(x){return import("fs");}']) {
    assert.throws(()=>runProgram(source,[]));
  }
});
test('coding evaluator requires dispatcher token and rejects invalid suites',async()=>{
  let payload;const handle=codingQualificationController({operatorToken:'test-token',readJsonBody:async()=>({level:'coding_medium',source:medium}),sendJson:(_r,_status,body)=>{payload=body;}});
  const url=new URL('https://chat.example/internal/qualification/coding');
  await assert.rejects(handle({url,request:{method:'POST',headers:{}},response:{}}),{statusCode:401});
  assert.equal(await handle({url,request:{method:'POST',headers:{authorization:'Bearer test-token'}},response:{}}),true);
  assert.equal(payload.passed,true);
});
