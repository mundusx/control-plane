// Bound scans so checking each streaming update stays cheap.
function repeatedCodeBlock(content) {
  for (const fence of content.matchAll(/```[^\n]*\n([\s\S]*?)(?:```|$)|~~~[^\n]*\n([\s\S]*?)(?:~~~|$)/g)) {
    const lines = (fence[1] ?? fence[2]).slice(-12288).split('\n');
    let property = null;
    let propertyRepeats = 0;
    for (const sourceLine of lines) {
      const line = sourceLine.trim();
      if (!/^["'][^"'\r\n]{3,}["']\s*:/.test(line)) {
        property = null; propertyRepeats = 0; continue;
      }
      propertyRepeats = line === property ? propertyRepeats + 1 : 1;
      property = line;
      if (propertyRepeats >= 6 && property.length * propertyRepeats >= 180) return property;
    }
    // Repeated records in a JSON array can be intentional. Only the adjacent
    // duplicate-property rule above applies to JSON data fences.
    if (/^(?:```|~~~)json(?:c|5)?[ \t]*\r?\n/i.test(fence[0])) continue;
    for (const line of lines) {
      if (line.length < 768 || /^\s*(?:#|\/\/|\*|<!--)/.test(line)) continue;
      const repeated = line.match(/(.{24,512}?)\1{5,}/);
      if (!repeated || repeated[0].length < 768) continue;
      const names = repeated[1].match(/[A-Za-z_]\w{2,}/g) ?? [];
      if (new Set(names).size >= 3 && /[=;{}]|\.\w+\(/.test(repeated[1])) return repeated[1];
    }
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

