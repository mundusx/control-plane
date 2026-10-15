// Bound scans so checking each streaming update stays cheap.
function repeatedCodeBlock(content) {
  for (const fence of content.matchAll(/```[^\n]*\n([\s\S]*?)(?:```|$)|~~~[^\n]*\n([\s\S]*?)(?:~~~|$)/g)) {
    const lines = (fence[1] ?? fence[2]).slice(-12288).split('\n');
    // Require six identical multi-line blocks, including real source syntax.
    // Ordinary repeated labels, prose, comments, and short boilerplate pass.
    for (let period = 3; period <= 32; period++) {
      let matches = 0;
      for (let i = period; i < lines.length; i++) {
        matches = lines[i] === lines[i - period] ? matches + 1 : 0;
        if (matches < period * 5) continue;
        const block = lines.slice(i - period + 1, i + 1).join('\n');
        const sourceLines = block.split('\n').filter(line => !/^\s*(?:$|#|\/\/|\*|<!--)/.test(line));
        if (block.length >= 80 && block.length * 6 >= 768 && sourceLines.length >= 3 && sourceLines.filter(line => /[=;{}]/.test(line)).length >= 3) return block;
      }
    }
  }
  return null;
}
export function assertNoRepetition(content) {
  // Strip fences before bounding the scan: a tail starting inside a long code
  // block otherwise loses its opening fence and mistakes code for prose.
  const prose = content.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '\n').slice(-12288);
  const codeBlock = repeatedCodeBlock(content);
  const match = prose.match(/([\s\S]{160,3000}?)\1\1/);
  if (!match && !codeBlock) return;
  const words = (match?.[1] ?? '').replace(/https?:\/\/\S+/g, '').match(/[a-zA-Z]{3,}/g) || [];
  if (!codeBlock && (words.length < 12 || new Set(words.map(word => word.toLowerCase())).size < 6)) return;
  const error = new Error('Response stopped because it began repeating. Please retry.');
  error.code = 'mundusx_repetition_detected';
  error.repeatedBlockCharacters = (codeBlock ?? match[1]).length;
  throw error;
}

