// Self-contained so the same parser can be embedded in the browser bundle.
export function splitMarkdownCode(value) {
  const text = String(value ?? "");
  const parts = [];
  const markers = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let outer = null;
  let inner = null;
  let cursor = 0;
  let match;
  while ((match = markers.exec(text))) {
    const marker = match[1];
    const info = match[2].trim();
    if (!outer) {
      if (marker[0] === "`" && info.includes("`")) continue;
      if (match.index > cursor) parts.push({ type: "text", value: text.slice(cursor, match.index) });
      outer = { marker, start: markers.lastIndex, language: info.split(/\s+/)[0] || "code" };
      continue;
    }
    const markdown = /^(?:markdown|md)$/i.test(outer.language);
    // Tolerate generated Markdown files whose inner labeled fences use the
    // same delimiter length as the outer file. Keep their contents verbatim.
    if (markdown && inner) {
      if (!info && marker[0] === inner[0] && marker.length >= inner.length) inner = null;
      continue;
    }
    if (markdown && info) { inner = marker; continue; }
    if (!info && marker[0] === outer.marker[0] && marker.length >= outer.marker.length) {
      parts.push({ type: "code", language: outer.language, value: text.slice(outer.start, match.index) });
      cursor = markers.lastIndex;
      outer = null;
    }
  }
  if (outer) parts.push({ type: "code", language: outer.language, value: text.slice(outer.start) });
  else if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts.length ? parts : [{ type: "text", value: text }];
}
