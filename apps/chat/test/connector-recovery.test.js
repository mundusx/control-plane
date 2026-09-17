import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { configFromEnv, page } from "../src/main.js";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const configure = source.slice(source.indexOf("    function configureAgentRecoveryAction("), source.indexOf('    projectAgentUpdateEl?.addEventListener("click"'));

test("only an older installed version offers an update download", () => {
  // Test the browser-rendered function so template-string escaping is covered.
  const html = page();
  const compare = html.slice(html.indexOf("    function releaseVersionAtLeast("), html.indexOf("    function renderActiveProject("));
  const attributes = new Map();
  const link = { dataset: {}, removeAttribute: (key) => attributes.delete(key), setAttribute: (key, value) => attributes.set(key, value) };
  const context = vm.createContext({ isWindowsAgentDevice: false, projectAgentUpdateEl: link, harnessDownloadEl: { href: "https://example.test/setup.exe" } });
  vm.runInContext(compare + configure, context);
  for (const [installed, required, needsUpdate] of [
    ["0.1.94-stall.1", "0.1.95", true],
    ["0.1.95", "0.1.95", false],
    ["0.1.56", "0.1.66", true],
    ["0.1.57", "0.1.66", true],
    ["0.1.66", "0.1.66", false],
    ["0.1.9", "0.1.66", true],
    ["0.1.100", "0.1.66", false],
    ["0.2.0", "0.1.66", false],
    ["1.0.0", "0.1.66", false],
    ["v0.1.66", "0.1.66", false],
    ["cli-v0.1.56", "0.1.66", true],
    ["unknown", "0.1.66", false],
  ]) {
    const updateAvailable = !context.releaseVersionAtLeast(installed, required);
    assert.equal(updateAvailable, needsUpdate, installed + " compared to " + required);
    context.configureAgentRecoveryAction(updateAvailable, true);
    assert.equal(attributes.has("download"), needsUpdate, installed);
    assert.equal(link.dataset.action, needsUpdate ? "update" : "reconnect", installed);
  }
});

test("paired offline computers hide the first-install download", () => {
  const config = configFromEnv({});
  const html = page(config);
  assert.match(html, /harnessDownloadEl\.hidden = ready \|\| paired/);
  assert.match(config.harnessRunnerDownloadUrl, /cli-windows-v0\.1\.80\/MundusX-Setup\.exe$/);
});

test("Reconnect opens the installed app without downloading; Update still downloads", () => {
  const attributes = new Map([["download", ""]]);
  const link = { dataset: {}, removeAttribute: (key) => attributes.delete(key), setAttribute: (key, value) => attributes.set(key, value) };
  const context = vm.createContext({ isWindowsAgentDevice: false, projectAgentUpdateEl: link, harnessDownloadEl: { href: "https://example.test/setup.exe" } });
  vm.runInContext(configure, context);
  context.configureAgentRecoveryAction(false, true);
  assert.equal(link.href, "mundusx://reconnect");
  assert.equal(link.dataset.action, "reconnect");
  assert.equal(attributes.has("download"), false);
  context.configureAgentRecoveryAction(true, true);
  assert.equal(link.href, "https://example.test/setup.exe");
  assert.equal(link.dataset.action, "update");
  assert.equal(attributes.has("download"), true);
});

test("Windows update opens the published release while other platforms retain their minimum", () => {
  const config = configFromEnv({});
  assert.equal(config.latestWindowsAgentVersion, "0.1.95");
  assert.equal(config.latestLocalAgentVersion, "0.1.87");
  const attributes = new Map([["download", ""]]);
  const link = { dataset: {}, removeAttribute: (key) => attributes.delete(key), setAttribute: (key, value) => attributes.set(key, value) };
  const context = vm.createContext({ isWindowsAgentDevice: true, windowsAgentUpdateUrl: config.windowsAgentUpdateUrl, projectAgentUpdateEl: link });
  vm.runInContext(configure, context);
  context.configureAgentRecoveryAction(true, false);
  assert.equal(link.href, "https://github.com/mundusx/releases/releases/tag/cli-windows-v0.1.95");
  assert.equal(link.target, "_blank");
  assert.equal(attributes.has("download"), false);
});

test("recovery keeps polling when known runners are still offline", async () => {
  const code = source.slice(source.indexOf("    function pollRunnerPairing()"), source.indexOf("    async function openProjects("));
  let scheduled;
  let schedules = 0;
  const context = vm.createContext({
    stopRunnerPairingPoll() {}, runnerPairingInProgress: true,
    runnerPairingExpiresAt: Date.now() + 600000, runnerPairingPollTimer: null,
    localRunnerReady: false, loadHarnessRunners: async () => [{ ready: false, fresh: false }],
    window: { setTimeout: (callback) => { scheduled = callback; schedules++; return schedules; } },
  });
  vm.runInContext(code, context);
  context.pollRunnerPairing();
  await scheduled();
  assert.equal(context.runnerPairingInProgress, true);
  assert.equal(schedules, 2);
  context.localRunnerReady = true;
  await scheduled();
  assert.equal(context.runnerPairingInProgress, false);
  assert.equal(schedules, 2);
});
