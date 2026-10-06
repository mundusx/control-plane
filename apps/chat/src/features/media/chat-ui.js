// Serialized into the existing Chat page. No untrusted content is inserted as HTML.
export function installMediaChatUi({ detect, cache, activeConversation, scroll, identity = () => null, requestAnother = () => {} }) {
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
    const visual = document.createElement('div'); visual.className = 'media-chat-loader'; visual.setAttribute('aria-hidden','true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 32 32');svg.setAttribute('fill','none');
    for (const [index,d] of ['M16 3C23.2 3 29 8.8 29 16','M29 16C29 23.2 23.2 29 16 29','M16 29C8.8 29 3 23.2 3 16','M3 16C3 8.8 8.8 3 16 3'].entries()) {
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d',d);path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','2.2');path.setAttribute('stroke-linecap','round');
      path.style.opacity=String(1-index*.2);svg.append(path);
    }
    visual.append(svg);
    const heading = document.createElement('strong');
    heading.textContent = item.kind === 'video' ? 'Creating your video' : 'Creating your image';
    const detail = document.createElement('p'); detail.className = 'media-chat-detail';
    detail.textContent = item.kind === 'video' ? (item.duration_seconds || 3) + ' seconds · Maximum 10 seconds' : 'Qwen Image · ' + (item.width || 832) + ' × ' + (item.height || 480);
    const status = document.createElement('p'); status.className = 'media-chat-status'; status.setAttribute('role','status');
    const queue = document.createElement('p'); queue.className = 'media-chat-queue';
    status.textContent = 'Submitting request…';
    card.setAttribute('aria-busy','true'); card.append(visual,heading,detail,status,queue); body.append(card);
    if (item.kind === 'image') {
      const another = document.createElement('button'); another.type = 'button'; another.className = 'media-chat-another';
      another.textContent = 'Create another image'; another.onclick = () => requestAnother(); card.append(another);
    }
    const live = () => identity() === owner && !control.signal.aborted && node.isConnected && activeConversation() === conversationId;
    const remember = () => identity() === owner && cache(conversationId, { role:'assistant', content:item.kind === 'video' ? 'Video generation' : 'Image generation', jobId:item.job_id,
      payload:{media_job:{...item}} });
    async function monitor() {
      try {
        while (live()) {
          const job = await api('/api/media/chat/jobs/' + encodeURIComponent(item.job_id));
          if (!live()) return;
          const pending = Number(job.pending_requests);
          queue.textContent = ['queued','running'].includes(job.state)
            ? (Number.isInteger(pending) ? pending + ' of ' + (job.max_pending_requests || 4) + ' media requests active. ' : '') +
              (pending >= (job.max_pending_requests || 4) ? 'Your media queue is full. You can keep chatting. ' : 'You can submit another request while this one waits. ') + 'Updates every 30 seconds.'
            : '';
          const another = card.querySelector('.media-chat-another');
          if (another) another.disabled = pending >= (job.max_pending_requests || 4);
          if (item.kind === 'image' && job.quote?.width && job.quote?.height) {
            item.width = job.quote.width; item.height = job.quote.height;
            detail.textContent = 'Qwen Image · ' + item.width + ' × ' + item.height;
          }
          if (job.state === 'completed') {
            if (!job.artifact?.media_available) throw Object.assign(new Error('This download has expired. Your job and credit records are retained.'),{status:410});
            const result = await api('/api/media/chat/jobs/' + encodeURIComponent(item.job_id) + '/result', {});
            if (!live()) return;
            const media = document.createElement(item.kind === 'video' ? 'video' : 'img');
            if (item.kind === 'video') { media.controls = true; media.preload = 'metadata'; }
            else { media.alt = item.prompt || 'Generated image'; media.loading = 'lazy'; }
            media.className = 'media-chat-output';
            const readyTitle = item.kind === 'video' ? 'Your video is ready' : 'Your image is ready';
            media.addEventListener(item.kind === 'video' ? 'loadedmetadata' : 'load', () => {
              if (!live()) return;
              heading.textContent = readyTitle;
              status.textContent = 'Download available until ' + new Date(result.expires_at).toLocaleString();
              scroll();
            });
            media.addEventListener('error', () => {
              if (!live()) return;
              media.hidden = true; heading.textContent = 'Your media is saved';
              status.textContent = 'Preview could not load. Try loading it again or use the download link.';
              if (card.querySelector('.media-chat-reload')) return;
              const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'media-chat-reload'; retry.textContent = 'Reload preview';
              retry.onclick = () => { retry.remove(); media.hidden = false; heading.textContent = 'Loading saved media…'; media.src = result.preview_url + (result.preview_url.includes('?') ? '&' : '?') + 'reload=' + Date.now(); };
              card.append(retry);
            });
            media.src = result.preview_url;
            visual.replaceWith(media); card.setAttribute('aria-busy','false');card.classList.add('media-chat-complete');
            heading.textContent = 'Loading saved media…';
            status.textContent = 'Generation completed. Loading the preview.';
            const link = document.createElement('a'); link.className = 'media-chat-download';
            link.href = result.download_url; link.textContent = item.kind === 'video' ? 'Download video' : 'Download image';
            card.append(link); scroll(); return;
          }
          if (job.state === 'failed' || job.state === 'cancelled') throw Object.assign(new Error(job.error || 'Generation ' + job.state + '. Please try a new request.'),{terminal:true});
          status.textContent = job.state === 'running' ? 'Generating… You can keep chatting.'
            : Number.isInteger(job.queue_position) ? 'Queued · Position ' + job.queue_position + ' · ' + job.jobs_ahead + ' compatible jobs ahead. Position may change.'
            : 'Queued — waiting for an available contributor. You can keep chatting.';
          await delay(Math.max(5, Math.min(60, Number(job.poll_after_seconds) || 30)) * 1000);
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
  async function submit(node, prompt, conversationId, detectedIntent, inputArtifactId) {
    const intent=detectedIntent ?? detect(prompt);
    if (!intent) return false;
    if (intent.error) { node.querySelector('.message-body').textContent=intent.error; cache(conversationId,{role:'assistant',content:intent.error}); return true; }
    const item={...intent,idempotency_key:crypto.randomUUID()};
    const view=mount(node,item,conversationId);
    const send=async()=>{
      try {
        const job=await api('/api/media/chat',{message:prompt,conversationId,input_artifact_id:inputArtifactId,idempotency_key:item.idempotency_key});
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
.media-chat-card{width:fit-content;max-width:min(100%,540px);display:grid;grid-template-columns:32px minmax(0,1fr);gap:4px 12px;padding:10px 0;background:transparent}
.media-chat-card strong{grid-column:2;font-size:14px;align-self:center}.media-chat-card p{margin:0}.media-chat-status{grid-column:2;font-size:13px;color:var(--muted);line-height:1.5}.media-chat-detail{display:none;font-size:13px;color:var(--muted);line-height:1.5}
.media-chat-queue{grid-column:2;font-size:12px;color:var(--muted);line-height:1.5}.media-chat-another{grid-column:2;margin-top:6px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);cursor:pointer}.media-chat-another:disabled{opacity:.5;cursor:default}
.media-chat-loader{grid-column:1;grid-row:1/3;align-self:center;width:32px;height:32px;color:var(--text)}
.media-chat-loader svg{display:block;width:32px;height:32px;animation:media-vector-turn 1.4s linear infinite;transform-origin:center}
@keyframes media-vector-turn{to{transform:rotate(360deg)}}
.media-chat-still svg{animation:none;opacity:.4}.media-chat-card button{grid-column:2;width:fit-content}
.media-chat-complete{width:min(100%,540px);display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--line);border-radius:20px;background:var(--panel);overflow:hidden}
.media-chat-complete .media-chat-detail{display:block}.media-chat-output{display:block;width:100%;max-height:520px;object-fit:contain;border-radius:13px;background:#10131a}
.media-chat-output[hidden]{display:none}
.media-chat-download{display:inline-block;width:fit-content;color:var(--text);font-size:14px;font-weight:600;text-decoration:underline;text-underline-offset:4px}
@media(prefers-reduced-motion:reduce){.media-chat-loader svg{animation:none}}
`;
