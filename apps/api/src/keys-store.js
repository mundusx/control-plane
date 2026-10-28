// API keys for the MundusX API gateway. Only SHA-256 hashes are stored; the key
// itself is shown once when it is created. The file is re-read when it
// changes, so new or revoked keys apply without a restart.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR =
  process.env.MUNDUSX_API_HOME ||
  path.join(os.homedir(), ".opengpu-api");
const KEYS_FILE = path.join(DIR, "api-keys.json");
const USAGE_FILE = path.join(DIR, "api-usage.jsonl");
const PREFIX = "mxapi_";
// Keys belong to an administrative user ID; no names or other personal data.
const USER_ID = /^[A-Z0-9._-]{2,64}$/;

let cache = { mtimeMs: -1, keys: [] };

function hash(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function load() {
  try {
    const { mtimeMs } = fs.statSync(KEYS_FILE);
    if (mtimeMs !== cache.mtimeMs)
      cache = { mtimeMs, keys: JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) };
  } catch {
    cache = { mtimeMs: -1, keys: [] };
  }
  const configured = JSON.parse(process.env.MUNDUSX_API_KEY_HASHES || "[]");
  if (
    !Array.isArray(configured) ||
    configured.some(
      (k) => typeof k.id !== "string" || !/^[a-f0-9]{64}$/.test(k.sha256 || ""),
    )
  )
    throw new Error("Invalid MUNDUSX_API_KEY_HASHES");
  return [
    ...configured.map((k) => ({
      ...k,
      revoked: !!k.revoked || !!cache.keys.find((e) => e.id === k.id)?.revoked,
    })),
    ...cache.keys.filter((k) => !configured.some((e) => e.id === k.id)),
  ];
}

function save(keys) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${KEYS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, KEYS_FILE);
}

function authenticate(presented) {
  if (!presented || presented.length < 32 || presented.length > 256)
    return null;
  const digest = hash(presented);
  return (
    load().find(
      (key) =>
        !key.revoked &&
        crypto.timingSafeEqual(
          Buffer.from(key.sha256, "hex"),
          Buffer.from(digest, "hex"),
        ),
    ) || null
  );
}

function normalizeUser(user) {
  const id = String(user || "")
    .trim()
    .toUpperCase();
  if (!USER_ID.test(id))
    throw new Error(
      "user ID must be 2-64 letters, digits, '.', '_' or '-' (e.g. DSATIKI)",
    );
  return id;
}

function create(user) {
  const key = PREFIX + crypto.randomBytes(24).toString("base64url");
  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    user: normalizeUser(user),
    sha256: hash(key),
    created: new Date().toISOString(),
    revoked: false,
  };
  save([...load(), entry]);
  return { key, entry };
}

function revoke(id) {
  const keys = load();
  const entry = keys.find((key) => key.id === id);
  if (!entry) return false;
  entry.revoked = true;
  save(keys);
  return true;
}

// Who used the API when, for how long — never prompts or answers.
function recordUsage(key, { path: route, status, ms }) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    key: key.id,
    user: key.user,
    route,
    status,
    ms,
  });
  fs.appendFile(USAGE_FILE, line + "\n", () => {});
}

module.exports = { authenticate, create, revoke, load, recordUsage, KEYS_FILE };
