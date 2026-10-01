import { createHash, timingSafeEqual } from "node:crypto";

const invalid = () => new Error("MUNDUSX_CHAT_API_KEYS must be a JSON array of unique {id, key} entries; IDs use 1-80 letters, digits, underscores or hyphens and keys use 32-256 visible ASCII characters");
const digest = (key) => createHash("sha256").update(key).digest();

export function parseChatApiKeys(raw) {
  if (raw === undefined) return null; // Explicit opt-in for existing deployments.
  let entries;
  try { entries = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(entries)) throw invalid();
  const ids = new Set();
  const hashes = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id)
      || typeof entry.key !== "string" || !/^[\x21-\x7e]{32,256}$/.test(entry.key)) throw invalid();
    const hash = digest(entry.key);
    const hex = hash.toString("hex");
    if (ids.has(entry.id) || hashes.has(hex)) throw invalid();
    ids.add(entry.id);
    hashes.add(hex);
    return { id: entry.id, hash };
  });
}

export function authenticateChatApiKey(authorization, keys) {
  if (keys == null) return { id: null, legacy: true };
  const match = typeof authorization === "string" && /^Bearer ([\x21-\x7e]{32,256})$/i.exec(authorization);
  if (!match) return null;
  const presented = digest(match[1]);
  let identity = null;
  for (const entry of keys) {
    if (timingSafeEqual(entry.hash, presented)) identity = { id: entry.id };
  }
  return identity;
}
