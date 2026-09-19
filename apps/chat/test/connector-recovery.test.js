import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { configFromEnv, discoverLatestAgentReleases, page } from "../src/main.js";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const configure = source.slice(source.indexOf("    function configureAgentRecoveryAction("), source.indexOf('    projectAgentUpdateEl?.addEventListener("click"'));

test("only an older installed version offers an update download", () => {
  // Test the browser-rendered function so template-string escaping is covered.
  const html = page();
  const compare = html.slice(html.indexOf("    function releaseVersionAtLeast("), html.indexOf("    function renderActiveProject("));
  const attributes = new Map();
  const link = { dataset: {}, removeAttribute: (key) => attributes.delete(key), setAttribute: (key, value) => attributes.set(key, value) };
  const context = vm.createContext({ isWindowsAgentDevice: false, localAgentReleaseUrl: "https://example.test/releases", projectAgentUpdateEl: link, harnessDownloadEl: { href: "https://example.test/setup.exe" } });
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
    assert.equal(attributes.has("download"), false, installed);
    assert.equal(link.dataset.action, needsUpdate ? "update" : "reconnect", installed);
  }
});

test("paired offline computers hide the first-install download", () => {
  const config = configFromEnv({});
  const html = page(config);
  assert.match(html, /harnessDownloadEl\.hidden = ready \|\| paired/);
  assert.match(config.harnessRunnerDownloadUrl, /cli-windows-v0\.2\.04\/MundusX-Setup\.exe$/);
});

test("Reconnect opens the installed app without downloading; Update still downloads", () => {
  const attributes = new Map([["download", ""]]);
  const link = { dataset: {}, removeAttribute: (key) => attributes.delete(key), setAttribute: (key, value) => attributes.set(key, value) };
  const context = vm.createContext({ isWindowsAgentDevice: false, localAgentReleaseUrl: "https://example.test/releases", projectAgentUpdateEl: link, harnessDownloadEl: { href: "https://example.test/setup.exe" } });
  vm.runInContext(configure, context);
  context.configureAgentRecoveryAction(false, true);
  assert.equal(link.href, "mundusx://reconnect");
  assert.equal(link.dataset.action, "reconnect");
  assert.equal(attributes.has("download"), false);
  context.configureAgentRecoveryAction(true, true);
  assert.equal(link.href, "https://example.test/releases");
  assert.equal(link.dataset.action, "update");
  assert.equal(attributes.has("download"), false);
});

test("agent compatibility and latest release versions are configured separately", () => {
  const config = configFromEnv({});
  assert.equal(config.minimumWindowsAgentVersion, "0.1.95");
  assert.equal(config.minimumLocalAgentVersion, "0.1.87");
  assert.equal(config.latestWindowsAgentVersion, "0.2.04");
  assert.equal(config.latestLocalAgentVersion, "0.2.04");
  const attributes = new Map([["download", ""]]);
  const link = { dataset: {}, removeAttribute: (key) => attributes.delete(key), setAttribute: (key, value) => attributes.set(key, value) };
  const context = vm.createContext({ isWindowsAgentDevice: true, windowsAgentUpdateUrl: config.windowsAgentUpdateUrl, localAgentReleaseUrl: config.localAgentReleaseUrl, projectAgentUpdateEl: link });
  vm.runInContext(configure, context);
  context.configureAgentRecoveryAction(true, false);
  assert.equal(link.href, "https://github.com/mundusx/releases/releases/download/cli-windows-v0.2.04/MundusX-Update.exe");
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

test("release discovery advances agent versions and trusted installer URLs", async () => {
  const config = configFromEnv({});
  const discovered = await discoverLatestAgentReleases(config, async () => ({
    ok: true,
    json: async () => [
      {
        tag_name: "cli-windows-v0.2.05",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/mundusx/releases/releases/tag/cli-windows-v0.2.05",
        assets: [
          { name: "MundusX-Update.exe", browser_download_url: "https://github.com/mundusx/releases/releases/download/cli-windows-v0.2.05/MundusX-Update.exe" },
          { name: "MundusX-Setup.exe", browser_download_url: "https://github.com/mundusx/releases/releases/download/cli-windows-v0.2.05/MundusX-Setup.exe" },
        ],
      },
      {
        tag_name: "cli-linux-v0.2.06",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/mundusx/releases/releases/tag/cli-linux-v0.2.06",
        assets: [],
      },
    ],
  }));
  assert.equal(discovered.latestWindowsAgentVersion, "0.2.05");
  assert.equal(discovered.latestLocalAgentVersion, "0.2.06");
  assert.match(discovered.windowsAgentUpdateUrl, /cli-windows-v0\.2\.05\/MundusX-Update\.exe$/);
  assert.match(discovered.harnessRunnerDownloadUrl, /cli-windows-v0\.2\.05\/MundusX-Setup\.exe$/);
  assert.match(discovered.localAgentReleaseUrl, /cli-linux-v0\.2\.06$/);
});

test("a selected project option continues execution with its prior context", () => {
  const html = page(configFromEnv({ MUNDUSX_HARNESS_UI_ENABLED: "true" }));
  const start = html.indexOf("    function requiresLocalProjectAction(");
  const end = html.indexOf("    async function tryLocalAgentTurn(");
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  const turns = [
    { role: "user", content: "Convert this app from MongoDB for local testing." },
    { role: "assistant", content: "Which approach do you prefer? Option 1: keep MongoDB. Option 2: migrate to Sequelize and SQLite. Should I proceed with Option 2?" },
    { role: "user", content: "choose option 2" },
    { role: "assistant", content: "I do not see the project request. Please clarify what you want me to plan." },
  ];
  assert.equal(context.isProjectExecutionContinuation("choose option 2", turns), true);
  assert.equal(context.isProjectExecutionContinuation("what is option 2?", turns), false);
  assert.equal(context.isProjectExecutionContinuation("choose option 2", []), false);
  const prompt = context.buildProjectExecutionContinuationPrompt("choose option 2", turns);
  assert.match(prompt, /Convert this app from MongoDB/);
  assert.match(prompt, /migrate to Sequelize and SQLite/);
  assert.match(prompt, /carry it out in the project now/);
  assert.match(prompt, /Latest user instruction:\nchoose option 2/);
  assert.match(html, /submittedProject && mutatingProjectRequest/);
  assert.match(html, /executionPrompt,/);
});
