import { parse } from 'acorn';
import { isDeepStrictEqual } from 'node:util';

// Interpret a bounded data-only JS subset. Model code is never eval'd, compiled,
// imported, or given host objects. Loops, recursion and allocations are bounded.
const FUNCTION = Symbol('interpreted function');
const BUILTIN = Symbol('safe intrinsic');
const blocked = new Set(['constructor','prototype','__proto__','process','require','eval','Function','globalThis']);
const key = value => { const k=String(value); if(blocked.has(k)||k.length>128) throw Error('Forbidden name'); return k; };
class Env {
  constructor(parent=null) { this.parent=parent; this.values=new Map(); }
  get(name) { key(name); if(this.values.has(name)) return this.values.get(name); if(this.parent) return this.parent.get(name); if(name==='undefined') return undefined; throw Error('Unknown name'); }
  set(name,value,declare=false) { key(name); if(!declare&&!this.values.has(name)&&this.parent) return this.parent.set(name,value); this.values.set(name,value); return value; }
}
class Signal { constructor(kind,value) { this.kind=kind;this.value=value; } }
export function runProgram(source,input) {
  if(typeof source!=='string'||source.length>16384) throw Error('Source limit');
  const ast=parse(source,{ecmaVersion:2022,sourceType:'script'});
  let remaining=120000,depth=0,allocation=65536;
  const tick=()=>{if(--remaining<0)throw Error('Execution budget');};
  const allocate=n=>{if((allocation-=n)<0)throw Error('Allocation budget');};
  const bounded=v=>{if((Array.isArray(v)||typeof v==='string')&&v.length>4096)throw Error('Allocation limit');if(typeof v==='number'&&!Number.isFinite(v))throw Error('Nonfinite number');return v;};
  function bind(pattern,value,env) {
    tick(); if(pattern.type==='Identifier') return env.set(pattern.name,value,true);
    if(pattern.type==='ArrayPattern'&&Array.isArray(value)) { pattern.elements.forEach((p,i)=>{if(p)bind(p,value[i],env);});return; }
    if(pattern.type==='ObjectPattern'&&value&&typeof value==='object') { for(const p of pattern.properties)bind(p.value,value[key(p.key.name??p.key.value)],env);return; }
    throw Error('Unsupported binding');
  }
  function call(fn,args) {
    tick();
    if(fn?.[BUILTIN]==='Number') {
      if(args[0]!==null&&!['string','number','boolean','undefined'].includes(typeof args[0]))throw Error('Primitive conversion required');
      return bounded(Number(args[0]));
    }
    if(!fn?.[FUNCTION]||++depth>24)throw Error('Invalid call or recursion limit');
    try { const env=new Env(fn.env);fn.node.params.forEach((p,i)=>bind(p,args[i],env));
      if(fn.node.body.type!=='BlockStatement')return expr(fn.node.body,env);
      const result=stmt(fn.node.body,env);return result instanceof Signal&&result.kind==='return'?result.value:undefined;
    } finally { depth--; }
  }
  function member(node,env) {
    const object=expr(node.object,env),name=key(node.computed?expr(node.property,env):node.property.name);
    if(object===null||object===undefined)throw Error('Invalid member');
    if(Array.isArray(object)||typeof object==='string') {
      if(name==='length')return object.length;
      if(/^-?\d+$/.test(name))return object[Number(name)];
      throw Error('Unsupported property');
    }
    if(typeof object!=='object'||object[FUNCTION])throw Error('Invalid object');
    return Object.hasOwn(object,name)?object[name]:undefined;
  }
  function method(node,args,env) {
    if(node.object.type==='Identifier'&&['Math','Object','Array'].includes(node.object.name)) {
      const name=key(node.computed?expr(node.property,env):node.property.name);
      if(node.object.name==='Math'&&['min','max','abs','floor'].includes(name)&&args.every(a=>typeof a==='number'))return Math[name](...args);
      if(node.object.name==='Array'&&name==='isArray')return Array.isArray(args[0]);
      if(node.object.name==='Object'&&['keys','values','entries'].includes(name)&&args[0]&&typeof args[0]==='object'&&!args[0][FUNCTION]){allocate(Object.keys(args[0]).length*3);return Object[name](args[0]);}
      throw Error('Unsupported builtin');
    }
    const object=expr(node.object,env),name=key(node.computed?expr(node.property,env):node.property.name);
    if(Array.isArray(object)) {
      if(name==='push'){allocate(args.length);if(object.length+args.length>4096)throw Error('Allocation limit');return object.push(...args);}
      if(name==='pop')return object.pop();
      if(name==='shift')return object.shift();
      if(name==='includes')return object.includes(args[0]);
      if(name==='indexOf')return object.indexOf(args[0]);
      if(name==='some')return object.some((v,i)=>call(args[0],[v,i]));
      if(name==='every')return object.every((v,i)=>call(args[0],[v,i]));
      if(name==='find')return object.find((v,i)=>call(args[0],[v,i]));
      if(name==='forEach'){object.forEach((v,i)=>call(args[0],[v,i]));return undefined;}
      if(name==='slice'){allocate(object.length);return object.slice(args[0],args[1]);}
      if(name==='sort')return object.sort(args.length?(a,b)=>call(args[0],[a,b]):undefined);
      if(name==='map'){allocate(object.length);return object.map((v,i)=>call(args[0],[v,i]));}
      if(name==='filter'){allocate(object.length);return object.filter((v,i)=>call(args[0],[v,i]));}
      if(name==='reduce'){if(args.length<2)throw Error('Explicit reduce seed required');return object.reduce((a,v,i)=>call(args[0],[a,v,i]),args[1]);}
      if(name==='join')return bounded(object.join(args[0]));
    }
    if(typeof object==='string') {
      if(name==='toLowerCase')return object.toLowerCase();
      if(name==='trim')return object.trim();
      if(name==='split')return bounded(object.split(args[0]));
      if(name==='slice')return object.slice(args[0],args[1]);
    }
    throw Error('Unsupported method');
  }
  function assign(node,value,env) {
    bounded(value);
    if(node.type==='Identifier')return env.set(node.name,value);
    if(node.type!=='MemberExpression')throw Error('Invalid assignment');
    const object=expr(node.object,env),name=key(node.computed?expr(node.property,env):node.property.name);
    if(!object||typeof object!=='object'||object[FUNCTION])throw Error('Invalid target');
    if(Array.isArray(object)&&(!/^\d+$/.test(name)||Number(name)>4095))throw Error('Invalid array index');
    if(!Object.hasOwn(object,name)&&Object.keys(object).length>=4096)throw Error('Allocation limit');
    object[name]=value;return value;
  }
  function expr(n,e) {
    tick();if(!n)return undefined;
    switch(n.type) {
      case 'Literal':if(n.regex||n.bigint)throw Error('Unsupported literal');return bounded(n.value);
      case 'Identifier':return e.get(n.name);
      case 'ArrayExpression':{const out=[];for(const x of n.elements){if(x?.type==='SpreadElement'){const values=expr(x.argument,e);if(!Array.isArray(values))throw Error('Spread requires bounded array');allocate(values.length);if(out.length+values.length>4096)throw Error('Allocation limit');out.push(...values);}else{allocate(1);out.push(expr(x,e));}}return bounded(out);}
      case 'ObjectExpression':{allocate(n.properties.length);const o=Object.create(null);for(const p of n.properties){if(p.type!=='Property'||p.kind!=='init'||p.method)throw Error('Invalid object');o[key(p.computed?expr(p.key,e):(p.key.name??p.key.value))]=expr(p.value,e);}return o;}
      case 'ArrowFunctionExpression':case 'FunctionExpression':if(n.async||n.generator)throw Error('Async unsupported');return {[FUNCTION]:true,node:n,env:e};
      case 'MemberExpression':return member(n,e);
      case 'CallExpression':{const args=n.arguments.map(a=>expr(a,e));return bounded(n.callee.type==='MemberExpression'?method(n.callee,args,e):call(expr(n.callee,e),args));}
      case 'ConditionalExpression':return expr(expr(n.test,e)?n.consequent:n.alternate,e);
      case 'LogicalExpression':{const a=expr(n.left,e);if(n.operator==='&&')return a&&expr(n.right,e);if(n.operator==='||')return a||expr(n.right,e);if(n.operator==='??')return a??expr(n.right,e);throw Error('Operator');}
      case 'UnaryExpression':{const a=expr(n.argument,e);if(n.operator==='!')return !a;if(n.operator==='-')return bounded(-a);if(n.operator==='+')return bounded(+a);throw Error('Operator');}
      case 'BinaryExpression':{const a=expr(n.left,e),b=expr(n.right,e);switch(n.operator){case '+':return bounded(a+b);case '-':return bounded(a-b);case '*':return bounded(a*b);case '/':return bounded(a/b);case '%':return bounded(a%b);case '<':return a<b;case '>':return a>b;case '<=':return a<=b;case '>=':return a>=b;case '===':return a===b;case '!==':return a!==b;case '==':return a==b;case '!=':return a!=b;default:throw Error('Operator');}}
      case 'AssignmentExpression':{const value=expr(n.right,e);if(n.operator==='=')return assign(n.left,value,e);const old=expr(n.left,e);if(n.operator==='+=')return assign(n.left,old+value,e);if(n.operator==='-=')return assign(n.left,old-value,e);throw Error('Assignment');}
      case 'UpdateExpression':{const old=expr(n.argument,e),next=old+(n.operator==='++'?1:-1);assign(n.argument,next,e);return n.prefix?next:old;}
      default:throw Error('Unsupported syntax');
    }
  }
  function stmt(n,e) {
    tick();if(!n)return;
    switch(n.type) {
      case 'Program':case 'BlockStatement':for(const s of n.body){const result=stmt(s,e);if(result instanceof Signal)return result;}return;
      case 'FunctionDeclaration':if(n.async||n.generator)throw Error('Async unsupported');e.set(n.id.name,{[FUNCTION]:true,node:n,env:e},true);return;
      case 'VariableDeclaration':for(const d of n.declarations)bind(d.id,expr(d.init,e),e);return;
      case 'ExpressionStatement':expr(n.expression,e);return;
      case 'ReturnStatement':return new Signal('return',expr(n.argument,e));
      case 'BreakStatement':return new Signal('break');
      case 'ContinueStatement':return new Signal('continue');
      case 'IfStatement':return stmt(expr(n.test,e)?n.consequent:n.alternate,e);
      case 'ForStatement':{const local=new Env(e);if(n.init?.type==='VariableDeclaration')stmt(n.init,local);else expr(n.init,local);while(!n.test||expr(n.test,local)){tick();const r=stmt(n.body,local);if(r?.kind==='return')return r;if(r?.kind==='break')break;expr(n.update,local);}return;}
      case 'WhileStatement':while(expr(n.test,e)){tick();const r=stmt(n.body,e);if(r?.kind==='return')return r;if(r?.kind==='break')break;}return;
      case 'ForOfStatement':{const values=expr(n.right,e);if(!Array.isArray(values))throw Error('Invalid iterable');for(const v of values){tick();const local=new Env(e);if(n.left.type!=='VariableDeclaration')throw Error('Declare loop variable');bind(n.left.declarations[0].id,v,local);const r=stmt(n.body,local);if(r?.kind==='return')return r;if(r?.kind==='break')break;}return;}
      case 'EmptyStatement':return;
      default:throw Error('Unsupported statement');
    }
  }
  const env=new Env();env.set('Number',{[BUILTIN]:'Number'},true);stmt(ast,env);const result=call(env.get('solve'),[structuredClone(input)]);
  let visits=0,bytes=0;const ancestors=new Set();
  function inspect(v){if(++visits>10000)throw Error('Output complexity');if(v&&typeof v==='object'){if(ancestors.has(v)||v[FUNCTION]||v[BUILTIN])throw Error('Invalid output');ancestors.add(v);for(const x of Object.values(v))inspect(x);ancestors.delete(v);}else if(typeof v==='string'){bytes+=v.length;if(bytes>65536)throw Error('Output bytes');}}
  inspect(result);
  const plain=JSON.stringify(result);if(plain===undefined||plain.length>65536)throw Error('Output limit');return JSON.parse(plain);
}

function merged(intervals) {
  const out=[];for(const [a,b] of intervals.map(x=>[...x]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])){const last=out.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);}return out;
}
function order(nodes,edges) {
  const out=[],remaining=new Set(nodes);while(remaining.size){const ready=[...remaining].filter(n=>!edges.some(([a,b])=>b===n&&remaining.has(a))).sort((a,b)=>a-b);if(!ready.length)return null;const n=ready[0];out.push(n);remaining.delete(n);}return out;
}
export function evaluateCoding({level,source}) {
  if(!['coding_medium','coding_large'].includes(level))throw Error('Unsupported coding suite');
  const cases=[];
  if(level==='coding_medium') {
    for(let seed=0;seed<40;seed++){const values=Array.from({length:seed%17},(_,i)=>(i*7+seed)%11-5);cases.push([values,[...new Set(values)].sort((a,b)=>a-b)]);}
  } else {
    for(let seed=0;seed<32;seed++){
      const nodes=Array.from({length:seed%6+1},(_,i)=>i);
      const intervals=Array.from({length:seed%11},(_,i)=>{const a=(i*7+seed)%19-5;return [a,a+(i+seed)%7];});
      const edges=nodes.flatMap(a=>nodes.filter(b=>a<b&&(a+b+seed)%3===0).map(b=>[a,b]));
      if(seed%5===0&&nodes.length>1)edges.push([0,1],[1,0]);
      cases.push([{intervals,nodes,edges},{intervals:merged(intervals),order:order(nodes,edges)}]);
    }
  }
  try {for(const [input,expected] of cases){if(!isDeepStrictEqual(runProgram(source,input),expected))return {passed:false,reason:'Algorithm test cases failed',cases:cases.length};}}
  catch {return {passed:false,reason:'Source exceeded the bounded executable language or resource limits',cases:cases.length};}
  return {passed:true,cases:cases.length,suite:'bounded-js-algorithms-v1'};
}
