const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
test("bootstrap keys can be revoked; only hashes are persisted; malformed bootstrap fails closed", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mundusx-api-keys-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.MUNDUSX_API_HOME = home;
  const key = "mxapi_" + crypto.randomBytes(32).toString("base64url");
  process.env.MUNDUSX_API_KEY_HASHES = JSON.stringify([
    {
      id: "bootstrap",
      user: "OWNER",
      sha256: crypto.createHash("sha256").update(key).digest("hex"),
    },
  ]);
  const keys = require("../src/keys-store");
  assert.equal(keys.authenticate(key).id, "bootstrap");
  assert.equal(keys.authenticate("invalid"), null);
  const created = keys.create("tester");
  assert.equal(keys.authenticate(created.key).user, "TESTER");
  const file = fs.readFileSync(keys.KEYS_FILE, "utf8");
  assert.ok(!file.includes(key));
  assert.ok(!file.includes(created.key));
  assert.equal(keys.revoke("bootstrap"), true);
  assert.equal(keys.authenticate(key), null);
  assert.ok(keys.authenticate(created.key));
  process.env.MUNDUSX_API_KEY_HASHES = "{}";
  assert.throws(() => keys.load(), /Invalid/);
});
