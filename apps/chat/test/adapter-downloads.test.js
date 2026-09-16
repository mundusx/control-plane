import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ADAPTER_PLATFORMS, detectAdapterOS, selectAdapterRelease, createAdapterDownloads } from "../src/adapter-downloads.js";
import { configFromEnv, page } from "../src/main.js";

function release(platform, version) {
  const tag = `${platform === "windows" ? "cli-windows" : platform.startsWith("macos") ? "adapter-macos" : "adapter-linux"}-v${version}`;
  return { tag_name: tag, assets: ["", ".sha256"].map(suffix => ({ name: ADAPTER_PLATFORMS[platform].asset + suffix, size: 123,
    browser_download_url: `https://github.com/mundusx/releases/releases/download/${tag}/${ADAPTER_PLATFORMS[platform].asset}${suffix}` })) };
}
test("detects desktop OS without guessing Mac CPU from Intel browser UA", () => {
  assert.equal(detectAdapterOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "macos");
  assert.equal(detectAdapterOS("Mozilla/5.0 (X11; Linux aarch64)"), "linux");
  assert.equal(detectAdapterOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(detectAdapterOS("iPad; CPU OS like Mac OS X Mobile"), "unknown");
});
test("selects newest compatible release per platform, never global latest or contributor package", () => {
  for (const key of Object.keys(ADAPTER_PLATFORMS)) {
    const entries = [release("windows", "0.1.999"), release(key,"0.1.92"), release(key,"0.1.93")];
    assert.equal(selectAdapterRelease(entries,key).version,key === "windows" ? "0.1.999" : "0.1.93");
    assert.equal(selectAdapterRelease([release(key,"0.1.66")],key),null);
    assert.equal(selectAdapterRelease([{...release(key,"0.1.93"), prerelease:true}],key),null);
    assert.equal(selectAdapterRelease([{...release(key,"0.1.93"), assets:[]}],key),null);
  }
  assert.equal(selectAdapterRelease([release("windows","0.1.92")],"macos-arm64"),null);
  assert.equal(selectAdapterRelease([],"__proto__"),null);
  assert.equal(selectAdapterRelease([release("windows","0.1.80")],"windows","0.1.92").version,"0.1.80");
});
test("project install and update cannot inherit a Windows-only environment override", () => {
  const html = page(configFromEnv({ MUNDUSX_HARNESS_UI_ENABLED:"true", MUNDUSX_HARNESS_RUNNER_DOWNLOAD_URL:"https://example.com/bad.exe" }));
  assert.doesNotMatch(html,/example.com\/bad.exe/);
  for (const id of ["harness-download","project-agent-update"]) {
    assert.match(html,new RegExp(`id="${id}"[^>]*href="/download/adapter"`));
  }
});
test("HTTP platform routes deliver correct assets and refuse cross-OS links", async t => {
  const releases = Object.keys(ADAPTER_PLATFORMS).map(key => release(key,"0.1.92"));
  let fetches = 0;
  const handle = createAdapterDownloads({ fetchImpl: async () => { fetches++; return {ok:true,json:async()=>releases}; } });
  const server = createServer((req,res)=>handle(req,res,new URL(req.url,"http://localhost")));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [ua,key] of [["Macintosh; Intel Mac OS X","macos-arm64"],["Linux","linux-x64"],["Linux aarch64","linux-arm64"],["Windows NT 10.0","windows"]]) {
    const result = await fetch(`${base}/download/adapter?platform=${key}&download=1`,{headers:{"User-Agent":ua},redirect:"manual"});
    assert.equal(result.status,302);
    assert.ok(result.headers.get("location").endsWith(ADAPTER_PLATFORMS[key].asset));
  }
  const mac = await fetch(`${base}/download/adapter?platform=windows&download=1`,{headers:{"User-Agent":"Macintosh"},redirect:"manual"});
  assert.equal(mac.status,200); assert.equal(mac.headers.get("location"),null);
  const html = await mac.text(); assert.doesNotMatch(html,/\.exe/); assert.match(html,/Apple Silicon/); assert.match(html,/Intel/);
  assert.equal(fetches,1);
});
test("release lookup failure produces a clear unavailable page without Windows fallback",async t=>{
  const handle = createAdapterDownloads({fetchImpl:async()=>{throw new Error("offline");}});
  const server = createServer((req,res)=>handle(req,res,new URL(req.url,"http://localhost")));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const result = await fetch(`http://127.0.0.1:${server.address().port}/download/adapter`,{headers:{"User-Agent":"Macintosh"}});
  assert.equal(result.status,503);assert.match(await result.text(),/Unable to check releases/);
});
