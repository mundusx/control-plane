// Conservative routing: discussion of media stays with the language model.
// Kept self-contained so browser and server use precisely the same parser.
export function mediaChatIntent(message) {
  const text = String(message || '').trim();
  if (!text || /^(?:how|why|what|explain|tell me|show me how)\b/i.test(text) ||
      /\b(?:don't|do not|never)\s+(?:create|generate|make|draw)\b/i.test(text) ||
      /\b(?:code|function|component|api|endpoint|script|tutorial|button|player)\b/i.test(text)) return null;
  const match = text.match(/^(?:(?:please|hey)[,\s]+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:create|generate|make|draw|render|produce|give me|show me|i\s+(?:want|need|would like|would love)(?:\s+(?:you|u)\s+to\s+(?:create|generate|make))?)\b[\s\S]{0,100}?\b(video|clip|image|picture|photo|illustration)\b/i);
  if (!match) return null;
  const kind = /video|clip/i.test(match[1]) ? 'video' : 'image';
  if (kind === 'image') return { kind, prompt: text };
  const duration = text.match(/\b(\d+(?:\.\d+)?)\s*[- ]?\s*(?:seconds?|secs?|s)\b/i);
  const words = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*[- ]?\s*seconds?\b/i);
  const seconds = duration ? Number(duration[1]) : words ? ['one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(words[1].toLowerCase())+1 : 3;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10 || /\b\d+\s*(?:minutes?|mins?|hours?)\b/i.test(text)) {
    return { kind, error: 'Videos can be 1–10 seconds long. Please choose a duration within that range; the default is 3 seconds.' };
  }
  return { kind, prompt: text, duration_seconds: seconds };
}
