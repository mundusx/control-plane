import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { configFromEnv, page } from "../src/main.js";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const configure = source.slice(
  source.indexOf("    function configureAgentRecoveryAction("),
  source.indexOf('    harnessDownloadEl?.addEventListener("click"'),
);

test("the default local-agent installer is a published Windows release", () => {
  const config = configFromEnv({});
  assert.equal(config.latestLocalAgentVersion, "0.1.80");
  assert.match(config.harnessRunnerDownloadUrl, /cli-windows-v0\.1\.80\/MundusX-Setup\.exe$/);
});

test("Reconnect opens the installed app while Update downloads the installer", () => {
  const attributes = new Map([["download", ""]]);
  const link = {
    dataset: {},
    removeAttribute: (key) => attributes.delete(key),
    setAttribute: (key, value) => attributes.set(key, value),
  };
  const context = vm.createContext({
    projectAgentUpdateEl: link,
    harnessDownloadEl: { href: "https://example.test/MundusX-Setup.exe" },
  });
  vm.runInContext(configure, context);

  context.configureAgentRecoveryAction(false, true);
  assert.equal(link.href, "mundusx://reconnect");
  assert.equal(link.dataset.action, "reconnect");
  assert.equal(attributes.has("download"), false);

  context.configureAgentRecoveryAction(true, true);
  assert.equal(link.href, "https://example.test/MundusX-Setup.exe");
  assert.equal(link.dataset.action, "update");
  assert.equal(attributes.has("download"), true);
});

test("paired offline computers hide the first-install download", () => {
  const html = page();
  assert.match(html, /harnessDownloadEl\.hidden = ready \|\| paired/);
  assert.match(html, /configureAgentRecoveryAction\(updateAvailable, paired && !localRunnerReady\)/);
});

test("recovery polling stops only after a runner becomes ready", async () => {
  const code = source.slice(
    source.indexOf("    function pollRunnerPairing()"),
    source.indexOf("    async function openProjects("),
  );
  let scheduled;
  let schedules = 0;
  const context = vm.createContext({
    stopRunnerPairingPoll() {},
    runnerPairingInProgress: true,
    runnerPairingExpiresAt: Date.now() + 600000,
    runnerPairingPollTimer: null,
    localRunnerReady: false,
    loadHarnessRunners: async () => [{ ready: false, fresh: false }],
    window: {
      setTimeout: (callback) => {
        scheduled = callback;
        schedules += 1;
        return schedules;
      },
    },
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
