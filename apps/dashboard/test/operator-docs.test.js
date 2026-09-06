import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

test("operator how-to documents the current cross-repo smoke path", () => {
  const docs = readFileSync(resolve(repoRoot, "docs/operator-howto.md"), "utf8");
  const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

  assert.match(readme, /docs\/operator-howto\.md/);
  assert.match(docs, /mundusx\/mundusx/);
  assert.match(docs, /mundusx\/control-plane/);
  assert.match(docs, /MUNDUSX_OPERATOR_TOKEN/);
  assert.match(docs, /MUNDUSX_AUTH_DISABLED=true/);
  assert.match(docs, /operator_auth_enforced=false/);
  assert.match(docs, /opengpu jobs submit/);
  assert.match(docs, /opengpu jobs wait <job_id> --timeout 300 --interval 2 --json/);
  assert.match(docs, /\/v1\/jobs\/:id/);
  assert.match(docs, /http:\/\/127\.0\.0\.1:3001\/portal\/jobs/);
  assert.match(docs, /Use JSON endpoints for diagnostics and scripts/);
  assert.match(docs, /https:\/\/uat\.mundusx\.ai\/health/);
  assert.match(docs, /storage_source` is `postgres` for shared UAT/);
  assert.match(docs, /storage_source=local-json-fallback/);
  assert.match(docs, /database\.runtime_pool\.configured=true/);
  assert.match(docs, /mundusx\/mundusx#73/);
  assert.match(docs, /mundusx\/mundusx#110/);
  assert.match(docs, /mundusx\/mundusx#111/);
  assert.match(docs, /mundusx\/mundusx#113/);
  assert.match(docs, /mundusx\/mundusx#114/);
});
