import {randomUUID} from 'node:crypto';
export class NativeToolFormatError extends Error { constructor(message){super(message);this.code='native_tool_format';} }
function validate(value,schema={}) {
 if(Array.isArray(schema.type)){const actual=value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)&&schema.type.includes('integer')?'integer':typeof value;if(!schema.type.includes(actual))throw new NativeToolFormatError('Invalid argument type');schema={...schema,type:actual};}
 if(schema.anyOf||schema.oneOf){const branches=schema.anyOf||schema.oneOf;const passed=branches.filter(branch=>{try{validate(value,branch);return true}catch{return false}}).length;if(!passed||(schema.oneOf&&passed!==1))throw new NativeToolFormatError('Invalid argument variant');}
 if(Object.hasOwn(schema,'const')&&JSON.stringify(value)!==JSON.stringify(schema.const))throw new NativeToolFormatError('Invalid constant argument');
 if(typeof value==='string'&&(value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)))throw new NativeToolFormatError('Invalid string length');
 if(schema.enum&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))throw new NativeToolFormatError('Invalid enum argument');
 if(schema.type==='object') {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new NativeToolFormatError('Expected object arguments');
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw new NativeToolFormatError('Missing required argument');
  for(const [key,item] of Object.entries(value)){if(schema.additionalProperties===false&&!Object.hasOwn(schema.properties||{},key))throw new NativeToolFormatError('Unknown argument');validate(item,schema.properties?.[key]);}
 }else if(schema.type==='array'){if(!Array.isArray(value)||value.length>(schema.maxItems??Infinity)||value.length<(schema.minItems??0))throw new NativeToolFormatError('Invalid array argument');for(const item of value)validate(item,schema.items);}
 else if(schema.type==='integer'){if(!Number.isInteger(value))throw new NativeToolFormatError('Invalid integer argument');}
 else if(schema.type==='null'){if(value!==null)throw new NativeToolFormatError('Expected null argument');}
 else if(schema.type&&typeof value!==schema.type)throw new NativeToolFormatError('Invalid argument type');
 if(typeof value==='number'&&(value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)))throw new NativeToolFormatError('Argument outside range');
}
export function normalizeNativeToolSse(source,request) {
 let content='',finish='',done=false,identity={},usage,calls=new Map();
 for(const frame of source.replace(/\r\n/g,'\n').split('\n\n')){
  const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;
  if(data.trim()==='[DONE]'){done=true;continue;}
  let event;try{event=JSON.parse(data)}catch{throw new NativeToolFormatError('Invalid model stream JSON');}
  if(event.error)throw Object.assign(new Error(event.error.message||'Model stream failed'),{code:'upstream_error'});
  if(event.usage)usage=event.usage;
  const choice=event.choices?.[0];if(!choice)continue;
  identity={...identity,...Object.fromEntries(['id','model','created'].filter(k=>event[k]!==undefined).map(k=>[k,event[k]]))};
  content+=choice.delta?.content||'';if(choice.finish_reason)finish=choice.finish_reason;
  for(const delta of choice.delta?.tool_calls||[]){if(!Number.isInteger(delta.index)||delta.index<0||delta.index>=32)throw new NativeToolFormatError('Invalid tool index');const call=calls.get(delta.index)||{id:'',type:'function',function:{name:'',arguments:''}};call.id+=delta.id||'';call.function.name+=delta.function?.name||'';call.function.arguments+=delta.function?.arguments||'';calls.set(delta.index,call);}
 }
 if(!done)throw new NativeToolFormatError('Incomplete model stream');
 if(finish==='length')throw new NativeToolFormatError('Tool turn reached generation limit');
 if(finish==='content_filter')throw Object.assign(new Error('Model turn was filtered; no tool executed'),{code:'upstream_error'});
 let normalized=[...calls.values()];
 if(!normalized.length&&/^\s*(?:<tool_call>\s*)?<function=/.test(content)){
  let remaining=content.trim().replace(/^<tool_call>\s*/,'').replace(/\s*<\/tool_call>$/,'');
  while(remaining.trim()){
   const match=/^\s*<function=([\w.-]+)>\s*([\s\S]*?)<\/function>/.exec(remaining);if(!match)throw new NativeToolFormatError('Incomplete Qwen tool call');
   const definition=request.tools?.find(t=>t.function?.name===match[1]);if(!definition)throw new NativeToolFormatError('Unknown tool');
   const args=Object.create(null);let parameters=match[2];
   while(parameters.trim()){
    const p=/^\s*<parameter=([\w.-]+)>\r?\n?([\s\S]*?)<\/parameter>/.exec(parameters);if(!p||Object.hasOwn(args,p[1]))throw new NativeToolFormatError('Malformed or duplicate parameter');
    const raw=p[2].replace(/\r?\n$/,'');try{args[p[1]]=definition.function.parameters?.properties?.[p[1]]?.type==='string'?raw:JSON.parse(raw);}catch{throw new NativeToolFormatError('Invalid parameter value');}parameters=parameters.slice(p[0].length);
   }
   normalized.push({id:randomUUID(),type:'function',function:{name:match[1],arguments:JSON.stringify(args)}});remaining=remaining.slice(match[0].length);
   if(normalized.length>32)throw new NativeToolFormatError('Too many calls');
  }
  content='';
 }
 const ids=new Set();for(const call of normalized){const definition=request.tools?.find(t=>t.function?.name===call.function.name);if(!definition||!call.id||ids.has(call.id))throw new NativeToolFormatError('Unknown or duplicate tool call');ids.add(call.id);let args;try{args=JSON.parse(call.function.arguments)}catch{throw new NativeToolFormatError('Incomplete tool arguments');}const parameters=definition.function.parameters;const declared=parameters?.properties;if(declared&&Object.keys(declared).length&&parameters.additionalProperties===undefined&&args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).some(key=>!Object.hasOwn(declared,key)))throw new NativeToolFormatError('Tool arguments contain undeclared fields');validate(args,parameters);}
 if(!normalized.length&&(finish==='tool_calls'||request.tool_choice==='required'))throw new NativeToolFormatError('Required tool call missing');
 if(!normalized.length&&!content.trim())throw new NativeToolFormatError('Empty model answer');
 if(!normalized.length)return source;
 const frame=choice=>'data: '+JSON.stringify({...identity,object:'chat.completion.chunk',choices:[{index:0,...choice}]})+'\n\n';
 return frame({delta:{role:'assistant',content:content||null,tool_calls:normalized.map((c,index)=>({index,...c}))},finish_reason:null})+frame({delta:{},finish_reason:'tool_calls'})+(usage?'data: '+JSON.stringify({...identity,object:'chat.completion.chunk',choices:[],usage})+'\n\n':'')+'data: [DONE]\n\n';
}
