// Only sustained, adjacent prose repetition counts. Code and short recurring
// labels are deliberately ignored; checking a bounded tail keeps streaming cheap.
export function assertNoRepetition(content) {
  // Strip fences before bounding the scan: a tail starting inside a long code
  // block otherwise loses its opening fence and mistakes code for prose.
  const prose = content.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '\n').slice(-12288);
  const match = prose.match(/([\s\S]{160,3000}?)\1\1/);
  if (!match) return;
  const words = match[1].replace(/https?:\/\/\S+/g, '').match(/[a-zA-Z]{3,}/g) || [];
  if (words.length < 12 || new Set(words.map(word => word.toLowerCase())).size < 6) return;
  const error = new Error('Response stopped because it began repeating. Please retry.');
  error.code = 'mundusx_repetition_detected';
  error.repeatedBlockCharacters = match[1].length;
  throw error;
}
