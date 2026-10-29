import { randomUUID } from 'node:crypto';

export function clientText(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';
}
export function activeImagePrompt(body) {
  const text = clientText(body.messages?.at(-1)?.content);
  // Copilot appends its actual request after environment and reminder blocks.
  // Never classify the context blocks or earlier conversation as a new request.
  if (!text.includes('<userRequest>')) return text;
  if ((text.match(/<userRequest>/g) ?? []).length !== 1) return '';
  return text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>\s*$/)?.[1] ?? '';
}
const ps = value => "'" + value.replaceAll("'", "''") + "'";
function completion(message, finish = 'stop') {
  return { id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),
    choices:[{index:0,message:{role:'assistant',...message},finish_reason:finish}] };
}

export function nativeImageSave(body, artifact) {
  const userContext = body.messages.filter(m => m.role === 'user').map(m => clientText(m.content)).join('\n');
  const workspace = userContext.match(/<workspace_info>\s*I am working in a workspace with the following folders:\s*\n-\s*([^\r\n]+)\s*\n(?!-)/)?.[1]?.trim();
  const prompt = activeImagePrompt(body);
  const requested = prompt.match(/\bsave\s+(?:it\s+)?(?:as|to)\s+[`"']?([\w./-]+\.png)\b/i)?.[1];
  const relative = requested ?? artifact.suggested_filename;
  if (!workspace || !/^[A-Za-z]:[\\/]/.test(workspace) || /[\r\n]/.test(workspace)
      || !/<environment_info>[\s\S]*?current OS is: Windows[\s\S]*?<\/environment_info>/.test(userContext)
      || !relative || relative.includes('\\') || relative.startsWith('/')
      || relative.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) return null;
  // Support the supplied Copilot schema without inventing a tool or parameter.
  const tool = body.tools.find(t => t.function?.name === 'run_in_terminal');
  if (!tool) return null;
  const properties = tool.function.parameters?.properties ?? {};
  const args = {command:'',explanation:'Download the generated image into the active workspace and verify the saved PNG.',
    goal:'Save the requested image in the current project',mode:'sync',isBackground:false,timeout:60000};
  for (const key of tool.function.parameters?.required ?? []) if (!(key in args)) return null;
  for (const [key, value] of Object.entries(args)) {
    if (!properties[key]) { delete args[key]; continue; }
    if (properties[key].enum && !properties[key].enum.includes(value)) return null;
  }
  if (properties.command?.type !== 'string') return null;
  const path = workspace.replaceAll('\\','/').replace(/\/$/,'')+'/'+relative;
  args.command = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Net.Http; `
    + `$ehdaRoot=[IO.Path]::GetFullPath(${ps(workspace)}); $ehdaFile=[IO.Path]::GetFullPath([IO.Path]::Combine($ehdaRoot,${ps(relative)})); `
    + `if(-not $ehdaFile.StartsWith($ehdaRoot.TrimEnd('\\')+'\\',[StringComparison]::OrdinalIgnoreCase)){throw 'Image path leaves workspace'}; `
    + `$ehdaParent=[IO.Path]::GetDirectoryName($ehdaFile); $ehdaCheck=$ehdaParent; while($ehdaCheck){if((Test-Path -LiteralPath $ehdaCheck) -and ((Get-Item -LiteralPath $ehdaCheck -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked image directories are not allowed'}; $ehdaCheck=[IO.Path]::GetDirectoryName($ehdaCheck)}; `
    + `$ehdaHttp=[Net.Http.HttpClient]::new(); try{$ehdaResponse=$ehdaHttp.GetAsync(${ps(artifact.url)}).GetAwaiter().GetResult(); $ehdaResponse.EnsureSuccessStatusCode()|Out-Null; `
    + `$ehdaBytes=$ehdaResponse.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult(); if($ehdaResponse.Content.Headers.ContentType.MediaType -ne 'image/png' -or $ehdaBytes.Length -lt 8 -or [BitConverter]::ToString($ehdaBytes,0,8) -ne '89-50-4E-47-0D-0A-1A-0A'){throw 'Download is not a PNG'}; `
    + `[IO.Directory]::CreateDirectory($ehdaParent)|Out-Null; $ehdaStream=[IO.File]::Open($ehdaFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try{$ehdaStream.Write($ehdaBytes,0,$ehdaBytes.Length)}finally{$ehdaStream.Dispose()}; `
    + `if((Get-Item -LiteralPath $ehdaFile).Length -ne $ehdaBytes.Length){throw 'Saved image verification failed'}; `
    + `Write-Output ('EHDA_IMAGE_SAVED:'+(@{path=$ehdaFile;byte_size=$ehdaBytes.Length}|ConvertTo-Json -Compress))}finally{$ehdaHttp.Dispose()}\n`
    + '# EHDA_IMAGE_TARGET '+JSON.stringify({path});
  return completion({content:'The image is generated. Saving and verifying it in your current workspace.',tool_calls:[{
    id:'call_ehda_image_save_'+randomUUID().replaceAll('-',''),type:'function',function:{name:tool.function.name,arguments:JSON.stringify(args)},
  }]},'tool_calls');
}

export function imageSaveResult(body) {
  const result = body.messages?.at(-1);
  if (result?.role !== 'tool' || !/^call_ehda_image_save_[0-9a-f]{32}$/.test(result.tool_call_id ?? '')) return null;
  const call = body.messages.slice(0,-1).findLast(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === result.tool_call_id))?.tool_calls.find(c => c.id === result.tool_call_id);
  if (!call) return null;
  let target;
  try { target = JSON.parse(JSON.parse(call.function.arguments).command.match(/# EHDA_IMAGE_TARGET (.+)$/)?.[1] ?? 'null'); } catch { return null; }
  if (!target?.path) return null;
  let saved;
  try { saved = JSON.parse(clientText(result.content).match(/EHDA_IMAGE_SAVED:(\{[^\r\n]+\})/)?.[1] ?? 'null'); } catch { /* Failed tool output remains a failure. */ }
  const verified = Number.isSafeInteger(saved?.byte_size) && saved.byte_size > 0
    && saved.path?.replaceAll('\\','/').toLowerCase() === target.path.toLowerCase();
  return { ...completion({content:verified ? `Saved and verified the image at ${target.path}.`
    : 'The image was generated, but the client did not confirm a successful file save. Check the terminal result; no successful local save is claimed.'}),
    mundusx:{file_saved:verified,...(verified ? {saved_path:target.path} : {})} };
}

export function imageUrlCompletion(artifact) {
  return completion({content:`Image generated: ${artifact.url}\nThe image has not been saved locally. Use your client download tool to save it in the active workspace.`});
}
