const {randomUUID,createHash}=require('node:crypto');
const {textOf}=require('./client-clarification');
function completion(content,toolCall) {
  return {id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),
    choices:[{index:0,message:{role:'assistant',content,...(toolCall?{tool_calls:[toolCall]}:{})},finish_reason:toolCall?'tool_calls':'stop'}],mundusx:{file_saved:false}};
}
const ps=s=>"'"+s.replaceAll("'","''")+"'";
const sh=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
function workspaceOf(body) {
  for(const message of [...(body.messages||[])].reverse()) {
    if(message.role!=='user'||typeof message.content!=='string'||!message.content.includes('<workspace_info>'))continue;
    return message.content.match(/<workspace_info>\s*I am working in a workspace with the following folders:\s*\n-\s*([^\r\n]+)\s*\n(?!-)/)?.[1]?.trim()||null;
  }
  return null;
}
function artifactSave(body,artifact,requestedPath) {
  const workspace=workspaceOf(body);
  const relative=requestedPath||artifact.filename;
  if(!workspace||!relative||!/^[\w./-]+$/.test(relative)||relative.startsWith('/')||relative.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))return completion('Artifact generated: '+artifact.url+'\nNo local file was saved. Choose a single workspace and use your client download tool.');
  const windows=/^[A-Za-z]:[\\/]/.test(workspace);
  if(!windows&&!workspace.startsWith('/'))return completion('Artifact generated: '+artifact.url+'\nNo unambiguous workspace path was supplied; no local save is claimed.');
  const target=workspace.replaceAll('\\','/').replace(/\/$/,'')+'/'+relative;
  const manifest={path:target,sha256:artifact.sha256,byte_size:artifact.byte_size,...(artifact.request_id?{artifact_request_id:artifact.request_id}:{})};
  let command;
  if(windows) {
    command=`$ErrorActionPreference='Stop'; $ehdaRoot=[IO.Path]::GetFullPath(${ps(workspace)}); $ehdaPath=[IO.Path]::GetFullPath(${ps(target)}); `
      + `if(-not $ehdaPath.StartsWith($ehdaRoot.TrimEnd('\\')+'\\',[StringComparison]::OrdinalIgnoreCase)){throw 'Destination escapes workspace'}; `
      + `$ehdaParent=[IO.Path]::GetDirectoryName($ehdaPath); $ehdaCheck=$ehdaPath; while($ehdaCheck){if(Test-Path -LiteralPath $ehdaCheck){if(([IO.File]::GetAttributes($ehdaCheck)-band [IO.FileAttributes]::ReparsePoint)-ne 0){$ehdaTag=& fsutil.exe reparsepoint query $ehdaCheck 2>&1; if($LASTEXITCODE-ne 0-or (($ehdaTag-join ' ')-notmatch '(?i)0x9000[0-9a-f]01a\\b')){throw 'Linked or unsupported reparse directories are not allowed'}}};$ehdaNext=[IO.Path]::GetDirectoryName($ehdaCheck);if($ehdaNext-eq $ehdaCheck){break};$ehdaCheck=$ehdaNext}; `
      + `if([IO.File]::Exists($ehdaPath)){$ehdaExisting=[IO.File]::ReadAllBytes($ehdaPath);$ehdaExistingHash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($ehdaExisting)).Replace('-','').ToLowerInvariant();if($ehdaExisting.Length-ne ${artifact.byte_size}-or $ehdaExistingHash-ne ${ps(artifact.sha256)}){throw 'Destination exists with different content; not overwritten'};Write-Output ${ps('EHDA_ARTIFACT_SAVED:'+JSON.stringify(manifest))};return}; `
      + `$ehdaHttp=New-Object Net.Http.HttpClient; try{$ehdaBytes=$ehdaHttp.GetByteArrayAsync(${ps(artifact.url)}).GetAwaiter().GetResult(); `
      + `$ehdaHash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($ehdaBytes)).Replace('-','').ToLowerInvariant(); if($ehdaBytes.Length-ne ${artifact.byte_size}-or $ehdaHash-ne ${ps(artifact.sha256)}){throw 'Artifact verification failed'}; `
      + `[IO.Directory]::CreateDirectory($ehdaParent)|Out-Null; $ehdaFile=[IO.File]::Open($ehdaPath,[IO.FileMode]::CreateNew); try{$ehdaFile.Write($ehdaBytes,0,$ehdaBytes.Length)}finally{$ehdaFile.Dispose()}; `
      + `$ehdaSaved=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($ehdaPath))).Replace('-','').ToLowerInvariant(); if($ehdaSaved-ne $ehdaHash){throw 'Saved file verification failed'}; Write-Output ${ps('EHDA_ARTIFACT_SAVED:'+JSON.stringify(manifest))}}finally{$ehdaHttp.Dispose()}`;
    command='Add-Type -AssemblyName System.Net.Http; '+command;
  } else {
    const code=`import pathlib,urllib.request,hashlib,json,sys\nroot=pathlib.Path(${JSON.stringify(workspace)})\np=root/${JSON.stringify(relative)}\nassert not root.is_symlink()\nfor parent in [p,*p.parents]:\n if parent.is_symlink(): raise RuntimeError('Linked paths are not allowed')\nassert p.resolve().is_relative_to(root.resolve())\nif p.exists():\n data=p.read_bytes()\n assert len(data)==${artifact.byte_size} and hashlib.sha256(data).hexdigest()==${JSON.stringify(artifact.sha256)},'Destination exists with different content; not overwritten'\n print(${JSON.stringify('EHDA_ARTIFACT_SAVED:'+JSON.stringify(manifest))})\n sys.exit(0)\nwith urllib.request.urlopen(${JSON.stringify(artifact.url)},timeout=60) as r: data=r.read(${artifact.byte_size+1})\nassert len(data)==${artifact.byte_size} and hashlib.sha256(data).hexdigest()==${JSON.stringify(artifact.sha256)}\np.parent.mkdir(parents=True,exist_ok=True)\nwith p.open('xb') as f: f.write(data)\nassert hashlib.sha256(p.read_bytes()).hexdigest()==${JSON.stringify(artifact.sha256)}\nprint(${JSON.stringify('EHDA_ARTIFACT_SAVED:'+JSON.stringify(manifest))})`;
    command='python3 -c '+sh(code);
  }
  command+='\n# EHDA_ARTIFACT_TARGET '+JSON.stringify(manifest);
  const tool=body.tools?.find(t=>t.type==='function'&&/(?:^|[_.:])(?:run_in_terminal|execute_command|run_command|command|bash|powershell|exec_command)$/i.test(t.function?.name||''));
  const props=tool?.function?.parameters?.properties||{};
  const key=Object.keys(props).find(k=>/^(?:command|cmd|commandLine|command_line|script)$/i.test(k)&&props[k].type==='string');
  const values={explanation:'Download and verify the generated artifact in the current workspace.',goal:'Save the requested artifact',mode:'sync',isBackground:false,timeout:60000};
  if(!key)return completion('Artifact generated: '+artifact.url+'\nNo compatible client save tool is available. No local file was saved.');
  values[key]=command;
  if((tool.function.parameters.required||[]).some(k=>!(k in values)))return completion('Artifact generated: '+artifact.url+'\nClient save schema is unsupported. No local file was saved.');
  const args=Object.fromEntries(Object.entries(values).filter(([k])=>k in props));
  const result=completion('Artifact generated. Saving and verifying it in your current workspace.',{id:'call_ehda_artifact_save_'+randomUUID().replaceAll('-',''),type:'function',function:{name:tool.function.name,arguments:JSON.stringify(args)}});
  return {...result,mundusx:{file_saved:false,artifact:{...artifact,url:artifact.url},requested_path:target}};
}
function artifactSaveResult(body) {
  const last=body.messages?.at(-1);
  if(last?.role!=='tool'||!/^call_ehda_artifact_save_[a-f0-9]{32}$/.test(last.tool_call_id||''))return null;
  const call=body.messages.slice(0,-1).reverse().find(m=>m.role==='assistant'&&m.tool_calls?.some(c=>c.id===last.tool_call_id))?.tool_calls.find(c=>c.id===last.tool_call_id);
  if(!call)return null;
  let args;try{args=JSON.parse(call.function.arguments)}catch{return null}
  const command=Object.values(args).find(v=>typeof v==='string'&&v.includes('# EHDA_ARTIFACT_TARGET '));
  let target;try{target=JSON.parse(command.split('# EHDA_ARTIFACT_TARGET ')[1])}catch{}
  // Terminal receipts may have CSI colours/mode changes or a JSON output wrapper.
  // Match complete output lines only: echoed command arguments are not evidence.
  function outputs(value,depth=0) {
    if(depth>6)return [];
    if(typeof value==='string'){try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object')return outputs(parsed,depth+1)}catch{}return [value]}
    if(Array.isArray(value))return value.flatMap(v=>outputs(v,depth+1));
    if(value&&typeof value==='object')return ['output','stdout','content','text','result','value'].flatMap(k=>k in value?outputs(value[k],depth+1):[]);
    return [];
  }
  const output=outputs(last.content).join('\n').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r\n?/g,'\n');
  let saved;
  for(const line of output.split('\n')) {
    const match=line.trim().match(/^EHDA_ARTIFACT_SAVED:(\{.*\})$/);if(!match)continue;
    try{const receipt=JSON.parse(match[1]);if(target&&receipt.path===target.path&&receipt.sha256===target.sha256&&receipt.byte_size===target.byte_size&&receipt.byte_size>0&&(!target.artifact_request_id||receipt.artifact_request_id===target.artifact_request_id))saved=receipt}catch{}
  }
  const ok=!!saved,conflict=/Destination exists with different content/i.test(output);
  const message=ok?'Saved and verified '+target.path+'.':conflict?'The destination '+(target?.path||'file')+' already contains a different file. It was not overwritten. Choose a new filename; the generated artifact is still available.':'The client did not return a verified save receipt. The generated artifact is retained; check the terminal error or retry its save.';
  return {...completion(message),mundusx:{file_saved:ok,...(target?.artifact_request_id?{artifact_request_id:target.artifact_request_id}:{}),...(conflict?{save_error:'destination_exists'}:{}),...(ok?{saved_path:target.path,sha256:target.sha256}:{})}};
}
module.exports={artifactSave,artifactSaveResult,completion,workspaceOf};
