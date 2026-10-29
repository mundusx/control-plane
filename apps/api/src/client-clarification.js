// Only the active request and its own adjacent clarification are actionable.
const MEDIA_TYPE_QUESTION = 'Are you trying to create an image? Please specify the type: still image (PNG), animation, or Scratch (.sb3) project.';
const LEGACY_PNG_QUESTION = 'This route currently generates PNG images. JPG/JPEG output is not connected yet. Reply PNG to create the image, or cancel.';
const FORMAT_QUESTION = 'Please choose a supported file type: PNG, JPG/JPEG, WebP, BMP, TIFF, AVIF, still GIF, or a basic Scratch (.sb3) sprite project. No job has been started.';
const GIF_TYPE_QUESTION = 'Should the GIF be a still image or animated? Reply still GIF for the supported still-image workflow; animated GIF generation is not connected yet. No job has been started.';
const aliases = {png:'png',jpg:'jpeg',jpeg:'jpeg',webp:'webp',webpn:'webp',bmp:'bmp',tif:'tiff',tiff:'tiff',avif:'avif',gif:'gif',sb3:'sb3',scratch:'sb3'};
function textOf(message) {
  let text=typeof message?.content==='string'?message.content:Array.isArray(message?.content)?message.content.filter(p=>p?.type==='text').map(p=>p.text||'').join('\n'):'';
  if(text.includes('<userRequest>')) {
    if((text.match(/<userRequest>/g)||[]).length!==1)return '';
    text=text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>\s*$/)?.[1]||'';
  }
  return text.trim();
}
const isQuestion = m => m?.role==='assistant' && [MEDIA_TYPE_QUESTION,LEGACY_PNG_QUESTION,FORMAT_QUESTION,GIF_TYPE_QUESTION].includes(m.content);
function visualCreationCandidate(text) {
  return !!text && text.length<=4000 && !/\b(?:code|function|component|api|endpoint|script|tutorial|button|player|database|website|app|story|poem)\b/i.test(text)
    && /^(?:(?:please|hey)[,\s]+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:create|generate|make|draw|render|design)\b/i.test(text)
    && /\b(?:image|picture|photo|illustration|logo|cat|kitten|dog|puppy|garfield|garfiled|landscape|mountain|portrait|character|animal|ninja|nija|costume|hat|dragon|robot|sprite|scratch|sb3)\b/i.test(text);
}
function requestedFormat(text, reply=false) {
  const path=text.match(/(?:\bsave\s+(?:it\s+)?(?:as|to)|\bas)\s+[`"']?([\w./-]+\.[a-z0-9]{2,12})\b/i)?.[1];
  const ext=path?.match(/\.([a-z0-9]{2,12})$/i)?.[1]?.toLowerCase();
  const words=[...text.toLowerCase().matchAll(/\b(png|jpg|jpeg|webp|webpn|bmp|tiff?|avif|gif|sb3|scratch|svg|pdf|psd|heic|ico|eps|mp4|animation|animated|video)\b/g)].map(m=>m[1]);
  if(ext)words.push(ext);
  const formats=[...new Set(words.map(w=>aliases[w]||w))];
  if(formats.length>1)return {unsupported:true};
  const format=formats[0] || (reply?text.toLowerCase().replace(/^[.]/,'').replace(/[.!]$/,'').trim():null);
  return {format:aliases[format]||format,unsupported:!!format && !Object.values(aliases).includes(aliases[format]||format),path};
}
function clientMediaClarification(body) {
  const messages=body?.messages;
  if(!Array.isArray(messages)||messages.at(-1)?.role!=='user')return null;
  const text=textOf(messages.at(-1));
  let index=messages.length-2;
  while(index>=3 && isQuestion(messages[index]) && messages[index-1]?.role==='user'
    && /^[a-z. -]{1,40}[.!]?$/i.test(textOf(messages[index-1])) && isQuestion(messages[index-2]))index-=2;
  const original=messages[index-1];
  const pending=isQuestion(messages[index]) && original?.role==='user' && visualCreationCandidate(textOf(original));
  if(pending && /^(?:hello|hi|thanks|thank you|how|why|what|explain)\b/i.test(text))return null;
  if(!pending && !visualCreationCandidate(text))return null;
  if(pending && /^(?:cancel|no|never mind|nevermind)[.!]?$/i.test(text))return {action:'cancelled',message:'Image request cancelled. No job has been started.'};
  const source=pending?textOf(original):text;
  const result=requestedFormat(text,pending);
  if(pending && /^(?:yes|sure|ok|okay)[.!]?$/i.test(text))return {action:'ask',message:FORMAT_QUESTION};
  if(pending && /^(?:image|still image|a still image|still image \(png\))$/i.test(text))result.format='png',result.unsupported=false;
  if(result.unsupported)return {action:'ask',message:FORMAT_QUESTION};
  if(result.format==='gif'&&!/\bstill\b/i.test(text))return {action:'ask',message:GIF_TYPE_QUESTION};
  if(result.format)return {action:'artifact',format:result.format,prompt:source,path:requestedFormat(source).path};
  if(pending)return null;
  if(/\b(?:image|picture|photo|illustration|logo|logotype|wordmark)\b/i.test(text))return null;
  return {action:'ask',message:MEDIA_TYPE_QUESTION};
}
module.exports={MEDIA_TYPE_QUESTION,FORMAT_QUESTION,visualCreationCandidate,clientMediaClarification,textOf,requestedFormat};
