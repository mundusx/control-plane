// Serialized into the existing Chat page. No untrusted content is inserted as HTML.
export function installMediaChatUi({ detect, cache, activeConversation, scroll, identity = () => null }) {
  const controllers = new WeakMap();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function api(path, body) {
    const response = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error || 'Media request failed'), { status: response.status });
    return value;
  }
  function mount(node, item, conversationId) {
    const owner = identity();
    controllers.get(node)?.abort();
    const control = new AbortController(); controllers.set(node, control);
    const body = node.querySelector('.message-body'); body.replaceChildren();
    const card = document.createElement('section'); card.className = 'media-chat-card';
    const visual = document.createElement('div'); visual.className = 'media-chat-mesh'; visual.setAttribute('aria-hidden','true');
    const heading = document.createElement('strong');
    heading.textContent = item.kind === 'video' ? 'Creating your video' : 'Creating your image';
    const detail = document.createElement('p'); detail.className = 'media-chat-detail';
    detail.textContent = item.kind === 'video' ? (item.duration_seconds || 3) + ' seconds · Maximum 10 seconds' : 'Qwen Image · 1024 × 1024';
    const status = document.createElement('p'); status.className = 'media-chat-status'; status.setAttribute('role','status');
    status.textContent = 'Submitting request…';
    card.setAttribute('aria-busy','true'); card.append(visual,heading,detail,status); body.append(card);
    const live = () => identity() === owner && !control.signal.aborted && node.isConnected && activeConversation() === conversationId;
    const remember = () => identity() === owner && cache(conversationId, { role:'assistant', content:item.kind === 'video' ? 'Video generation' : 'Image generation', jobId:item.job_id,
      payload:{media_job:{...item}} });
    async function monitor() {
      try {
        while (live()) {
          const job = await api('/api/media/chat/jobs/' + encodeURIComponent(item.job_id));
          if (!live()) return;
          if (job.state === 'completed') {
            if (!job.artifact?.media_available) throw Object.assign(new Error('This download has expired. Your job and credit records are retained.'),{status:410});
            const result = await api('/api/media/chat/jobs/' + encodeURIComponent(item.job_id) + '/result', {});
            if (!live()) return;
            const media = document.createElement(item.kind === 'video' ? 'video' : 'img');
            if (item.kind === 'video') { media.controls = true; media.preload = 'metadata'; }
            else { media.alt = item.prompt || 'Generated image'; media.loading = 'lazy'; }
            media.className = 'media-chat-output'; media.src = result.preview_url;
            visual.replaceWith(media); card.setAttribute('aria-busy','false');
            heading.textContent = item.kind === 'video' ? 'Your video is ready' : 'Your image is ready';
            status.textContent = 'Download available until ' + new Date(result.expires_at).toLocaleString();
            const link = document.createElement('a'); link.className = 'media-chat-download';
            link.href = result.download_url; link.textContent = item.kind === 'video' ? 'Download video' : 'Download image';
            card.append(link); scroll(); return;
          }
          if (job.state === 'failed' || job.state === 'cancelled') throw Object.assign(new Error(job.error || 'Generation ' + job.state + '. Please try a new request.'),{terminal:true});
          status.textContent = job.state === 'running' ? 'Generating… You can keep chatting.' : 'Queued — waiting for an available contributor. You can keep chatting.';
          await delay(15000);
        }
      } catch (error) {
        if (!live()) return;
        card.setAttribute('aria-busy','false'); visual.classList.add('media-chat-still');
        heading.textContent = error.status === 410 ? 'Download expired' : 'Generation update';
        status.textContent = error.message;
        if (!error.terminal && ![401,403,404,410].includes(error.status)) {
          const retry = document.createElement('button'); retry.type='button'; retry.textContent='Check again';
          retry.onclick=()=>{retry.remove();visual.classList.remove('media-chat-still');card.setAttribute('aria-busy','true');monitor();};card.append(retry);
        }
      }
    }
    return { monitor, remember, status, card, visual, live };
  }
  async function submit(node, prompt, conversationId) {
    const intent=detect(prompt);
    if (!intent) return false;
    if (intent.error) { node.querySelector('.message-body').textContent=intent.error; cache(conversationId,{role:'assistant',content:intent.error}); return true; }
    const item={...intent,idempotency_key:crypto.randomUUID()};
    const view=mount(node,item,conversationId);
    const send=async()=>{
      try {
        const job=await api('/api/media/chat',{message:prompt,conversationId,idempotency_key:item.idempotency_key});
        item.job_id=job.job_id; view.remember();
        if (view.live()) view.monitor();
      } catch(error) {
        if (!view.live()) return;
        view.card.setAttribute('aria-busy','false');view.visual.classList.add('media-chat-still');view.status.textContent=error.message;
        const retry=document.createElement('button');retry.type='button';retry.textContent='Retry request';
        retry.onclick=()=>{retry.remove();view.visual.classList.remove('media-chat-still');view.card.setAttribute('aria-busy','true');send();};view.card.append(retry);
      }
    };
    await send();return true;
  }
  function restore(node, item, conversationId) { if(item?.job_id) mount(node,item,conversationId).monitor(); }
  return {submit,restore};
}

export const mediaChatCss = `
.media-chat-card{width:min(100%,540px);display:grid;gap:12px;padding:16px;border:1px solid var(--line);border-radius:20px;background:var(--panel);overflow:hidden}
.media-chat-card strong{font-size:16px}.media-chat-card p{margin:0}.media-chat-detail,.media-chat-status{font-size:13px;color:var(--muted);line-height:1.5}
.media-chat-mesh{height:270px;border-radius:13px;position:relative;overflow:hidden;background:#141b32}
.media-chat-mesh::before{content:'';position:absolute;inset:-55%;background:radial-gradient(ellipse at 28% 32%,#87b2ff 0%,transparent 42%),radial-gradient(ellipse at 76% 42%,#b394f8 0%,transparent 45%),radial-gradient(ellipse at 48% 80%,#38b9b1 0%,transparent 45%);filter:blur(22px);animation:media-mesh-drift 7s ease-in-out infinite alternate}
.media-chat-mesh::after{content:'';position:absolute;inset:0;background-image:linear-gradient(#ffffff10 1px,transparent 1px),linear-gradient(90deg,#ffffff10 1px,transparent 1px);background-size:26px 26px;opacity:.45}
@keyframes media-mesh-drift{from{transform:rotate(-10deg) translate(-3%,-2%) scale(1)}to{transform:rotate(24deg) translate(6%,3%) scale(1.15)}}
.media-chat-still::before{animation:none}.media-chat-output{display:block;width:100%;max-height:520px;object-fit:contain;border-radius:13px;background:#10131a}
.media-chat-download{display:inline-block;width:fit-content;color:var(--text);font-size:14px;font-weight:600;text-decoration:underline;text-underline-offset:4px}
@media(prefers-reduced-motion:reduce){.media-chat-mesh::before{animation:none}}
`;
