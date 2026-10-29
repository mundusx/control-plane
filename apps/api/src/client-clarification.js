// Conversation-local clarification: no global pending state or cross-chat lookup.
const MEDIA_TYPE_QUESTION = 'Are you trying to create an image? Please specify the type: still image (PNG), animation, or Scratch (.sb3) project.';
const PNG_TYPE_QUESTION = 'This route currently generates PNG images. JPG/JPEG output is not connected yet. Reply PNG to create the image, or cancel.';
const isQuestion = message => message?.role === 'assistant' && [MEDIA_TYPE_QUESTION, PNG_TYPE_QUESTION].includes(message.content);

function textOf(message) {
  let text = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content)
    ? message.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') : '';
  if (text.includes('<userRequest>')) {
    if ((text.match(/<userRequest>/g) || []).length !== 1) return '';
    text = text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>\s*$/)?.[1] || '';
  }
  return text.trim();
}

function visualCreationCandidate(text) {
  if (!text || text.length > 4000 || /\b(?:code|function|component|api|endpoint|script|tutorial|button|player|file|folder|test|database|website|app|story|poem)\b/i.test(text)) return false;
  return /^(?:(?:please|hey)[,\s]+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:create|generate|make|draw|render|design)\b/i.test(text)
    && /\b(?:cat|kitten|dog|puppy|garfield|garfiled|landscape|mountain|portrait|character|animal|ninja|nija|costume|hat|dragon|robot|sprite)\b/i.test(text);
}

function clientMediaClarification(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.at(-1)?.role !== 'user') return null;
  const text = textOf(messages.at(-1));
  let index = messages.length - 2;
  while (index >= 3 && isQuestion(messages[index])
    && messages[index-1]?.role === 'user' && /^(?:yes|sure|ok|okay|jpg|jpeg|a jpg|a jpeg|jpg image|jpeg image)[.!]?$/i.test(textOf(messages[index-1]))) index -= 2;
  const previous = messages[index], original = messages[index-1];
  const pending = isQuestion(previous)
    && original?.role === 'user' && visualCreationCandidate(textOf(original));
  if (pending) {
    const choice = text.toLowerCase().replace(/[.!]$/, '').trim();
    if (/^(?:png|a png|png image|still image|a still image|image|still image \(png\))$/.test(choice))
      return { action: 'image', prompt: 'Create an image in PNG format. Original request: ' + textOf(original), originalMessage: original };
    if (/^(?:animation|animated|gif|video|scratch|sb3|\.sb3|scratch \(\.sb3\) project|scratch project)$/.test(choice))
      return { action: 'unsupported', message: 'This VS Code media route currently supports still images in PNG format. Animation and Scratch (.sb3) generation are not connected yet. No job has been started.' };
    if (/^(?:yes|sure|ok|okay)$/.test(choice)) return { action: 'ask', message: MEDIA_TYPE_QUESTION };
    if (/^(?:jpg|jpeg|a jpg|a jpeg|jpg image|jpeg image)$/.test(choice)) return { action: 'ask', message: PNG_TYPE_QUESTION };
    return null;
  }
  if (!visualCreationCandidate(text)) return null;
  if (/\b(?:jpg|jpeg)\b/i.test(text)) return { action: 'ask', message: PNG_TYPE_QUESTION };
  if (/\b(?:png)\b/i.test(text)) return { action: 'image', prompt: 'Create an image in PNG format. Original request: ' + text };
  if (/\b(?:image|picture|photo|illustration|logo|logotype|wordmark|video|animation|scratch|sb3|gif|jpeg|jpg|svg|webp)\b/i.test(text)) return null;
  return { action: 'ask', message: MEDIA_TYPE_QUESTION };
}

module.exports={MEDIA_TYPE_QUESTION,visualCreationCandidate,clientMediaClarification};

