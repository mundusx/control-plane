const {createHash,createHmac}=require('node:crypto');
function clientMediaRoute(body) {
  const last=body.messages?.at(-1);
  if(last?.role==='tool' && /^call_ehda_image_save_[0-9a-f]{32}$/.test(last.tool_call_id||'')) return true;
  if(last?.role!=='user'||body.tool_choice==='none'||!Array.isArray(body.tools)) return false;
  let text=typeof last.content==='string'?last.content:Array.isArray(last.content)?last.content.filter(p=>p.type==='text').map(p=>p.text||'').join('\n'):'';
  if(text.includes('<userRequest>')) {
    if((text.match(/<userRequest>/g)||[]).length!==1)return false;
    text=text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>\s*$/)?.[1]||'';
  }
  if(text.length>4000||/^(?:how|why|what|explain|tell me|show me how)\b/i.test(text)||/\b(?:code|function|component|api|endpoint|script|tutorial|button|player)\b/i.test(text)||/\b(?:don't|do not|never)\s+(?:create|generate|make|draw)\b/i.test(text))return false;
  if(!/^(?:(?:please|hey)[,\s]+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:design|create|generate|make|draw|render|produce|give me|show me|i\s+(?:want|need|would like))\b[\s\S]{0,100}?\b(?:image|picture|photo|illustration|logo|logotype|wordmark)\b/i.test(text))return false;
  return body.tools.some(t=>t.type==='function' && /(?:^|[_.:])(?:run_in_terminal|execute_command|run_command|command|bash|powershell|exec_command)$/i.test(t.function?.name||'') && Object.entries(t.function?.parameters?.properties||{}).some(([name,schema])=>/^(?:command|cmd|commandLine|command_line|script)$/i.test(name)&&schema?.type==='string'));
}
function mediaHeaders(key,body,secret,now=Date.now()) {
  const timestamp=String(now),digest=createHash('sha256').update(body).digest('hex');
  return {'x-mundusx-image-key-id':key.id,'x-mundusx-image-timestamp':timestamp,
    'x-mundusx-image-signature':createHmac('sha256',secret).update(key.id+'\n'+timestamp+'\n'+digest).digest('hex')};
}
module.exports={clientMediaRoute,mediaHeaders};
