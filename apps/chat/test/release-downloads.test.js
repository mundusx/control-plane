import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_ASSETS,
  RELEASE_BACKEND_BASE_URL,
  releaseDownloadLocation,
} from "../src/release-downloads.js";

test("production release channel redirects every published Harness asset", () => {
  for (const asset of RELEASE_ASSETS) {
    assert.equal(
      releaseDownloadLocation(`/prod/latest/${asset}`),
      `${RELEASE_BACKEND_BASE_URL}/${asset}`,
    );
  }
});

test("production release channel rejects unknown and nested asset paths", () => {
  assert.equal(releaseDownloadLocation("/prod/latest/not-published.exe"), null);
  assert.equal(releaseDownloadLocation("/prod/latest/../release-manifest.json"), null);
  assert.equal(releaseDownloadLocation("/prod/latest/"), null);
  assert.equal(releaseDownloadLocation("/other/latest/release-manifest.json"), null);
});
