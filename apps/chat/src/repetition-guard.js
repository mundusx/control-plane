// Only sustained, adjacent prose repetition counts. Code and short recurring
// labels are deliberately ignored; checking a bounded tail keeps streaming cheap.
export function assertNoRepetition(content) {
  const tail = content.slice(-12288);
  const prose = tail.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  const match = prose.match(/([\s\S]{160,3000}?)\1\1/);
  if (!match || !/[a-zA-Z]{3}/.test(match[1])) return;
  const error = new Error('Response stopped because it began repeating. Please retry.');
  error.code = 'mundusx_repetition_detected';
  throw error;
}
