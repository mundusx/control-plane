export function renderSkillsPage({ user, csrfToken }) {
  const bootstrap = JSON.stringify({ user, csrfToken }).replace(/</g, "\\u003c");
  return String.raw`<!doctype html><html lang="en"><head>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&amp;family=Space+Grotesk:wght@400;500;600;700&amp;display=swap"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal instructions · MundusX Chat</title>
  <style>
button,input,select,textarea { font-family:inherit; } code,pre,kbd,samp { font-family:"JetBrains Mono",ui-monospace,monospace; }:root{color-scheme:dark;--bg:#080b17;--panel:#11162a;--text:#f5f6ff;--muted:#aab2c8;--line:#29314d;--accent:#7b7cff;--danger:#ef6b73}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Space Grotesk", system-ui, sans-serif}button,input,textarea{font:inherit}header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid var(--line)}a{color:var(--accent);text-decoration:none}.layout{width:min(1180px,calc(100% - 32px));margin:28px auto;display:grid;grid-template-columns:340px 1fr;gap:20px}.panel{border:1px solid var(--line);border-radius:16px;background:var(--panel)}.sidebar,.editor{padding:18px}.section-title{display:flex;justify-content:space-between;align-items:center;margin:18px 0 8px}.items{display:grid;gap:7px}.item{width:100%;padding:10px;text-align:left;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--text);cursor:pointer}.item:hover,.item.active{border-color:var(--line);background:#181e39}.item small{display:block;color:var(--muted)}.badge{display:inline-block;padding:2px 7px;border-radius:999px;background:#20294b;color:var(--muted);font-size:11px}.editor{display:grid;gap:14px}label{display:grid;gap:6px;font-weight:700}input,textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px;background:var(--bg);color:var(--text)}textarea{min-height:270px;font-family: "JetBrains Mono", ui-monospace, monospace}.row{display:flex;gap:9px;flex-wrap:wrap;align-items:center}button{border:1px solid var(--line);border-radius:9px;padding:9px 13px;color:var(--text);background:var(--panel);cursor:pointer}.primary{background:var(--accent);border-color:transparent;color:#fff}.danger{color:var(--danger)}.muted{color:var(--muted)}.notice{padding:12px;border:1px solid var(--line);border-radius:10px;background:#181e39}.hidden{display:none}.status{min-height:22px}@media(max-width:760px){.layout{grid-template-columns:1fr}}</style></head>
  <body><header><strong>MundusX Chat · Personalization</strong><span id="identity"></span><a href="/?settings=personalization">Back to Settings</a></header>
  <main class="layout"><aside class="panel sidebar"><p class="notice">Personal instructions apply only to your account and follow you across chats.</p><div class="section-title"><strong>Personal instructions</strong><button id="new" type="button">New instruction</button></div><div class="items" id="personal"></div><p class="muted" id="empty" hidden>No personal instructions yet. Add preferences such as your language, answer length, tone, or coding style.</p></aside>
  <section class="panel editor" style="align-self:start"><div><h2 id="heading">Select an instruction</h2><p class="muted" id="scope">Choose an instruction or create one.</p></div>
  <form id="form" class="hidden"><label>Identifier<input id="slug" maxlength="100" required placeholder="my-writing-style"></label><label>Title<input id="title" maxlength="100" required></label><label>Description<input id="description" maxlength="500"></label><label>Instructions<textarea id="content" maxlength="12000" required placeholder="# My preferences&#10;&#10;- Keep explanations concise.&#10;- Reply in English unless I request another language."></textarea></label><label class="row"><input id="enabled" type="checkbox" style="width:auto" checked> Enabled</label><div class="row"><button class="primary" id="save" type="submit">Save</button><button class="danger hidden" id="remove" type="button">Delete</button></div></form><p class="status" id="status" role="status"></p></section></main>
  <script>
  const boot=${bootstrap}, $=id=>document.getElementById(id); let skills=[],active=null;
  $('identity').textContent=boot.user.display_name||boot.user.email;
  async function api(path,options={}) {
    const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.method?{'X-MundusX-CSRF':boot.csrfToken}:{})}});
    const body=await response.json().catch(()=>({})); if(!response.ok)throw new Error(body.error||'Request failed'); return body;
  }
  function select(entry={}) {
    active=entry; $('form').classList.remove('hidden'); $('heading').textContent=entry.title||'New personal instruction';
    $('scope').textContent='Personal instruction · only your account';
    for(const key of ['slug','title','description','content'])$(key).value=entry[key]||'';
    $('enabled').checked=entry.enabled!==false; $('remove').classList.toggle('hidden',!entry.skill_id); $('status').textContent='';
  }
  async function load() {
    const data=await api('/api/skills'); skills=data.personal; $('personal').replaceChildren(); $('empty').hidden=skills.length>0;
    for(const entry of skills){const b=document.createElement('button'); b.className='item'; const title=document.createElement('strong'),description=document.createElement('small');title.textContent=entry.title;description.textContent=(entry.enabled?'Enabled':'Disabled')+' · '+(entry.description||'Personal instruction');b.append(title,description);b.onclick=()=>select(entry);$('personal').append(b);}
  }
  $('new').onclick=()=>select();
  $('form').onsubmit=async event=>{event.preventDefault();$('save').disabled=true;try{
    const payload={enabled:$('enabled').checked};for(const key of ['slug','title','description','content'])payload[key]=$(key).value;
    const saved=await api('/api/skills/personal'+(active.skill_id?'/'+active.skill_id:''),{method:active.skill_id?'PUT':'POST',body:JSON.stringify(payload)});
    await load();select(skills.find(x=>x.skill_id===saved.skill_id)||saved);$('status').textContent='Saved.';
  }catch(e){$('status').textContent=e.message}finally{$('save').disabled=false}};
  $('remove').onclick=async()=>{if(!active?.skill_id||!confirm('Delete this personal instruction?'))return;try{await api('/api/skills/personal/'+active.skill_id,{method:'DELETE'});await load();active=null;$('form').classList.add('hidden');$('heading').textContent='Select an instruction';$('status').textContent='Deleted.'}catch(e){$('status').textContent=e.message}};
  load().then(()=>{if(skills[0])select(skills[0])}).catch(e=>{$('heading').textContent='Skills unavailable';$('status').textContent=e.message});
  </script></body></html>`;
}
