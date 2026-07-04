import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { connect as createTlsConnection } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_CONTROL_PLANE_URL = "https://uat.mundusx.ai";
const DEFAULT_TIMEOUT_SECONDS = 90;
const DEFAULT_WEATHER_TTL_SECONDS = 7200;
const DEFAULT_WEATHER_URL = "https://wttr.in";
const DEFAULT_FACTUAL_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary";
const DEFAULT_WIKIDATA_ENTITY_URL = "https://www.wikidata.org/wiki/Special:EntityData";
const DEFAULT_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 4;
const DEFAULT_WEB_SEARCH_TTL_SECONDS = 1800;
const DEFAULT_WEB_SEARCH_DAILY_BUDGET = 0;
const POLL_INTERVAL_MS = 1500;
const MAX_BODY_BYTES = 64 * 1024;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = resolve(MODULE_DIR, "../public/mundusx-logo.png");
const MARIE_PERSONA_PATH = resolve(MODULE_DIR, "../../../docs/marie-persona.md");
const ATLAS_PERSONA_PATH = resolve(MODULE_DIR, "../../../docs/atlas-persona.md");
const MARIE_PERSONA = loadPersona(
  MARIE_PERSONA_PATH,
  [
    "Marie represents the MundusX open-source team's vision of making artificial intelligence accessible, affordable, and beneficial for everyone.",
    "Marie supports MundusX's mission to grow a community-powered decentralized AI compute network.",
    "Marie should be professional, honest, helpful, and responsible.",
  ].join(" "),
);
const ATLAS_PERSONA = loadPersona(
  ATLAS_PERSONA_PATH,
  [
    "Atlas represents the MundusX open-source team's vision of making artificial intelligence accessible, affordable, and beneficial for everyone.",
    "Atlas supports MundusX's mission to grow a community-powered decentralized AI compute network.",
    "Atlas should be professional, honest, helpful, and responsible.",
  ].join(" "),
);

const ICON_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const ICON_UPGRADE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c0 3-1 5.5-2.5 7S6 12 3 12c3 0 5.5 1 7 2.5S12 18 12 21c0-3 1-5.5 2.5-7S18 12 21 12c-3 0-5.5-1-7-2.5S12 6 12 3z"/></svg>';
const ICON_PERSONALIZATION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M13 7l-4 6h3l-1 4 4-6h-3l1-4z"/></svg>';
const ICON_PROFILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="2.5"/><path d="M7 17.5c1.2-2 3-3 5-3s3.8 1 5 3"/></svg>';
const ICON_SETTINGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_HELP_RING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5.5 5.5l3 3M15.5 15.5l3 3M18.5 5.5l-3 3M8.5 15.5l-3 3"/></svg>';
const ICON_LOGOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M15 16l4-4-4-4"/><path d="M19 12H9"/></svg>';
const ICON_ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const ICON_ARROW_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_CPU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 7V4M15 7V4M9 20v-3M15 20v-3M7 9H4M7 15H4M20 9h-3M20 15h-3"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M17.5 3.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 8.5-8.5Z"/></svg>';
const ICON_LAYERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/></svg>';
const ICON_CHAT_BUBBLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>';
const ICON_VOLUME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

const WELCOME_INNER_HTML = `<div class="welcome-inner">
              <h1>Welcome to <span class="grad-text">MundusX</span> Chat</h1>
              <div class="welcome-rule"></div>
              <p class="welcome-copy">Ask anything about MundusX - contributors, architecture, nodes, jobs, or anything else.</p>
              <div class="examples-heading"><span>Example Questions</span></div>
              <div class="suggestions">
                <button class="suggestion" type="button"><span class="suggestion-icon icon-purple">${ICON_CLOCK}</span><span class="suggestion-text">Give me a detailed history of Honda from its origins to today.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
                <button class="suggestion" type="button"><span class="suggestion-icon icon-blue">${ICON_CPU}</span><span class="suggestion-text">Explain why a CUDA node can claim a job and fail.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
                <button class="suggestion" type="button"><span class="suggestion-icon icon-green">${ICON_EDIT}</span><span class="suggestion-text">Draft a product description for MundusX contributors.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
                <button class="suggestion" type="button"><span class="suggestion-icon icon-orange">${ICON_LAYERS}</span><span class="suggestion-text">Summarize the current control-plane architecture.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
              </div>
            </div>`;

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? "3002"),
    controlPlaneUrl: normalizeOrigin(env.MUNDUSX_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL),
    operatorToken: (env.MUNDUSX_OPERATOR_TOKEN ?? env.OPENGPU_OPERATOR_TOKEN ?? "").trim(),
    modelOverride: (env.MUNDUSX_CHAT_MODEL ?? env.MUNDUSX_CHAT_DEFAULT_MODEL ?? "").trim(),
    weatherCacheUrl: (
      env.MUNDUSX_WEATHER_CACHE_URL ??
      env.VALKEY_URL ??
      env.REDIS_URL ??
      ""
    ).trim(),
    weatherBaseUrl: normalizeOrigin(env.MUNDUSX_WEATHER_URL ?? DEFAULT_WEATHER_URL),
    factualSummaryBaseUrl: normalizeOrigin(
      env.MUNDUSX_FACTUAL_SUMMARY_URL ?? DEFAULT_FACTUAL_SUMMARY_URL,
    ),
    wikidataEntityBaseUrl: normalizeOrigin(
      env.MUNDUSX_WIKIDATA_ENTITY_URL ?? DEFAULT_WIKIDATA_ENTITY_URL,
    ),
    weatherTtlSeconds: positiveInteger(
      env.MUNDUSX_WEATHER_TTL_SECONDS,
      DEFAULT_WEATHER_TTL_SECONDS,
    ),
    defaultTimeoutSeconds: positiveInteger(
      env.MUNDUSX_CHAT_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
    ),
    webSearchBaseUrl: normalizeOrigin(env.MUNDUSX_WEB_SEARCH_URL ?? DEFAULT_WEB_SEARCH_URL),
    webSearchApiKey: (env.MUNDUSX_WEB_SEARCH_API_KEY ?? "").trim(),
    webSearchMaxResults: positiveInteger(
      env.MUNDUSX_WEB_SEARCH_MAX_RESULTS,
      DEFAULT_WEB_SEARCH_MAX_RESULTS,
    ),
    webSearchTtlSeconds: positiveInteger(
      env.MUNDUSX_WEB_SEARCH_TTL_SECONDS,
      DEFAULT_WEB_SEARCH_TTL_SECONDS,
    ),
    webSearchDailyBudget: positiveInteger(
      env.MUNDUSX_WEB_SEARCH_DAILY_BUDGET,
      DEFAULT_WEB_SEARCH_DAILY_BUDGET,
    ),
  };
}

export function page(config = configFromEnv()) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MundusX Chat</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --rail: #ffffff;
      --panel: #ffffff;
      --panel-2: #ffffff;
      --line: #e7e9f2;
      --line-strong: #d7dbec;
      --text: #12131c;
      --muted: #6b7280;
      --muted-2: #94a3b8;
      --purple: #7c6cf6;
      --blue: #3b82f6;
      --cyan: #2f6fed;
      --green: #17a668;
      --red: #e5484d;
      --amber: #b45309;
      --gradient: linear-gradient(135deg, #3b8bff 0%, #7c5cf0 100%);
      --motion-fast: 140ms ease;
      --motion-medium: 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
      --focus-ring: 0 0 0 3px rgba(124, 108, 246, 0.28);
    }
    * { box-sizing: border-box; }
    html {
      width: 100%;
      overflow-x: hidden;
    }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
    }
    a { color: inherit; text-decoration: none; }
    button { font: inherit; cursor: pointer; }
    button:focus-visible,
    a:focus-visible {
      outline: 0;
      box-shadow: var(--focus-ring);
    }
    code {
      background: rgba(124, 108, 246, 0.1);
      border: 1px solid rgba(124, 108, 246, 0.18);
      border-radius: 8px;
      color: #4338ca;
      padding: 2px 6px;
    }

    .shell {
      height: 100vh;
      min-height: 0;
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr);
    }

    /* ---- Sidebar / menu column ---- */
    aside {
      height: 100vh;
      min-height: 0;
      border-right: 1px solid var(--line);
      background: var(--rail);
      padding: 22px 16px 18px;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto auto;
      gap: 16px;
    }
    .brand-block {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 2px 4px;
    }
    .brand-logo {
      width: 40px;
      height: 40px;
      object-fit: contain;
      flex: 0 0 auto;
      transition: transform var(--motion-medium);
    }
    .brand-block:hover .brand-logo {
      transform: scale(1.04);
    }
    .brand-name {
      font-family: Inter, "Segoe UI", sans-serif;
      font-weight: 800;
      font-size: 19px;
      line-height: 1.15;
      color: var(--text);
    }
    .brand-kicker {
      margin-top: 3px;
      color: var(--muted-2);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .network-summary {
      display: flex;
      align-items: center;
      min-height: 48px;
      padding: 0 16px;
      border-radius: 10px;
      border: 1px solid rgba(107, 114, 128, 0.18);
      background: rgba(107, 114, 128, 0.06);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      width: 100%;
    }
    .network-summary.is-online {
      border-color: rgba(23, 166, 104, 0.28);
      background: #eafbf2;
      color: var(--green);
    }
    .network-summary.is-waiting {
      border-color: #f7dfae;
      background: #fff6e8;
      color: var(--amber);
    }
    .network-summary.is-offline {
      border-color: rgba(229, 72, 77, 0.28);
      background: #fdedee;
      color: var(--red);
    }
    .network-signal {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .online-dot,
    .network-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }

    .new-chat {
      width: 100%;
      min-height: 48px;
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      color: var(--text);
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 0 16px;
      font-weight: 650;
      font-size: 14px;
      transition: background var(--motion-fast);
    }
    .new-chat:hover,
    .new-chat:focus-visible {
      background: #f1f2f9;
    }
    .new-chat .kbd-hint {
      background: #f4f5f9;
      border: 1px solid var(--line-strong);
      color: var(--muted);
      border-radius: 6px;
      padding: 3px 7px;
      font-size: 12px;
      font-weight: 600;
    }

    .rail-list {
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      display: grid;
      align-content: start;
      gap: 14px;
      padding-right: 2px;
    }
    .history-group {
      display: grid;
      gap: 6px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .history-group:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .history-label {
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .history-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      overflow: hidden;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 9px 10px;
      color: #414a5a;
      font-size: 13px;
      background: transparent;
      transition: color var(--motion-fast), background var(--motion-fast);
    }
    .history-item:hover,
    .history-item:focus-visible {
      color: var(--text);
      background: #f1f2f9;
      outline: 0;
    }
    .history-item.active {
      color: var(--purple);
      border-color: rgba(124, 108, 246, 0.4);
      background: linear-gradient(90deg, rgba(124, 108, 246, 0.14), rgba(59, 130, 246, 0.06));
    }
    .history-title {
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-time {
      flex: 0 0 auto;
      color: var(--muted-2);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-empty {
      min-height: 100%;
      display: grid;
      align-content: center;
      justify-items: center;
      gap: 6px;
      text-align: center;
      padding: 12px 8px;
    }
    .history-empty-icon {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: #f1ecfe;
      color: var(--purple);
      margin-bottom: 6px;
    }
    .history-empty-icon svg { width: 22px; height: 22px; }
    .history-empty-title {
      color: var(--text);
      font-weight: 700;
      font-size: 14px;
    }
    .history-empty-copy {
      color: var(--muted-2);
      font-size: 12px;
    }

    .rail-footer {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      padding: 14px;
      color: var(--muted-2);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .network-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: var(--text);
      font-weight: 650;
      font-size: 13px;
    }
    .network-line span:first-child { display: inline-flex; align-items: center; gap: 8px; }
    .network-line .network-dot { color: var(--green); }
    .network-line span:last-child { color: var(--cyan); font-size: 12px; font-weight: 700; letter-spacing: 0.03em; }
    #network-latency { color: var(--green); font-weight: 700; }

    .account-widget {
      position: relative;
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .account-bar {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px solid transparent;
      border-radius: 12px;
      background: #f1f2f9;
      padding: 8px 10px;
      text-align: left;
      transition: background var(--motion-fast);
    }
    .account-bar:hover,
    .account-bar:focus-visible {
      background: #e7e8f2;
      outline: 0;
    }
    .account-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: #b8462c;
      color: #fff;
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 12px;
      flex: 0 0 auto;
    }
    .account-info {
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .account-name {
      color: var(--text);
      font-weight: 600;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .account-plan {
      color: var(--muted-2);
      font-size: 11px;
    }
    .account-upgrade {
      margin-left: auto;
      flex: 0 0 auto;
      border: 1px solid var(--line-strong);
      background: #fff;
      border-radius: 999px;
      padding: 5px 12px;
      font-weight: 700;
      font-size: 12px;
      color: var(--text);
    }

    .account-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 100%;
      margin-bottom: 8px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 20px 45px rgba(15, 23, 42, 0.16);
      padding: 8px;
      display: none;
      z-index: 40;
    }
    .account-menu.is-open { display: block; }
    .account-menu-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 12px;
      border: 0;
      background: transparent;
      border-radius: 8px;
      padding: 8px;
      text-align: left;
      transition: background var(--motion-fast);
    }
    .account-menu-header:hover,
    .account-menu-header:focus-visible {
      background: #f1f2f9;
      outline: 0;
    }
    .account-menu-header-text {
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .account-menu-name {
      color: var(--text);
      font-weight: 600;
      font-size: 14px;
    }
    .account-menu-plan {
      color: var(--muted-2);
      font-size: 12px;
    }
    .account-menu-divider {
      border-top: 1px solid var(--line);
      margin: 6px 4px;
    }
    .account-menu-item {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 12px;
      border: 0;
      background: transparent;
      border-radius: 8px;
      padding: 9px 8px;
      color: var(--text);
      font-size: 14px;
      text-align: left;
      transition: background var(--motion-fast);
    }
    .account-menu-item:hover,
    .account-menu-item:focus-visible {
      background: #f1f2f9;
      outline: 0;
    }
    .account-menu-item svg {
      width: 18px;
      height: 18px;
      color: var(--muted);
      flex: 0 0 auto;
    }
    .chevron { margin-left: auto; color: var(--muted-2); flex: 0 0 auto; }
    .chevron svg { width: 16px; height: 16px; display: block; }

    /* ---- Main column ---- */
    main {
      min-width: 0;
      height: 100vh;
      min-height: 0;
      display: grid;
      grid-template-rows: 58px minmax(0, 1fr) auto;
      background: transparent;
    }
    header {
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 16px;
    }
    .runtime-status-sentinel {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 14px;
      color: var(--green);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      background: #fff;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }
    .runtime-status-sentinel[data-state="working"] { color: var(--amber); }
    .runtime-status-sentinel[data-state="error"] { color: var(--red); }
    .header-actions {
      display: none;
    }

    .messages {
      min-height: 0;
      min-width: 0;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .conversation {
      width: min(880px, 100%);
      min-width: 0;
      margin: 0 auto;
      padding: 38px 18px 28px;
      display: grid;
      gap: 8px;
    }
    .welcome {
      min-height: 40vh;
      display: grid;
      place-items: center;
      text-align: center;
    }
    .welcome-inner {
      width: min(680px, 100%);
      display: grid;
      gap: 16px;
      justify-items: center;
    }
    h1 {
      margin: 0;
      color: var(--text);
      font-size: clamp(28px, 4.4vw, 40px);
      line-height: 1.1;
      font-weight: 800;
    }
    h1 .grad-text {
      background: var(--gradient);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .welcome-rule {
      width: 46px;
      height: 3px;
      border-radius: 2px;
      background: var(--gradient);
    }
    .welcome-copy {
      max-width: 40rem;
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
    }
    .examples-heading {
      width: min(560px, 100%);
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 16px;
      margin-top: 4px;
      color: var(--muted-2);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .examples-heading::before,
    .examples-heading::after {
      content: "";
      border-top: 1px solid var(--line);
    }
    .suggestions {
      width: min(700px, 100%);
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .suggestion {
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr) 16px;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel-2);
      color: var(--text);
      text-align: left;
      font-size: 13px;
      line-height: 1.4;
      padding: 12px 14px;
      transition: transform var(--motion-medium), border-color var(--motion-fast), box-shadow var(--motion-medium);
    }
    .suggestion:hover,
    .suggestion:focus-visible {
      transform: translateY(-2px);
      border-color: var(--line-strong);
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.1);
    }
    .suggestion-icon {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      flex: 0 0 auto;
    }
    .suggestion-icon svg { width: 18px; height: 18px; }
    .suggestion-icon.icon-purple { background: #f1ecfe; color: var(--purple); }
    .suggestion-icon.icon-blue { background: #e8f2ff; color: var(--blue); }
    .suggestion-icon.icon-green { background: #e7f9ee; color: var(--green); }
    .suggestion-icon.icon-orange { background: #fff1e0; color: #ea8a2b; }
    .suggestion-arrow {
      color: var(--muted-2);
      flex: 0 0 auto;
    }
    .suggestion-arrow svg { width: 16px; height: 16px; }

    .message {
      width: 100%;
      min-width: 0;
      display: flex;
      padding: 10px 0;
    }
    .message.user {
      justify-content: flex-end;
    }
    .message-body {
      min-width: 0;
      max-width: min(760px, 82%);
      color: var(--text);
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .message.user .message-body {
      max-width: min(660px, 74%);
      background: linear-gradient(90deg, rgba(124, 108, 246, 0.12), rgba(59, 130, 246, 0.08));
      border: 1px solid rgba(124, 108, 246, 0.25);
      border-radius: 16px 16px 4px 16px;
      padding: 12px 16px;
    }
    .message.assistant .message-body {
      width: 100%;
      max-width: 100%;
    }
    .message.error .message-body {
      color: #b3231f;
    }
    .meta {
      color: var(--muted-2);
      font-size: 12px;
      margin-top: 8px;
    }
    .message-body p { margin: 0 0 12px; }
    .message-body p:last-child { margin-bottom: 0; }
    .message-body ol,
    .message-body ul {
      margin: 10px 0 12px;
      padding-left: 24px;
    }
    .message-body li {
      margin: 8px 0;
      padding-left: 4px;
    }
    .message-body strong {
      font-weight: 800;
    }
    .message-body code:not(.code-block code) {
      background: rgba(0,0,0,0.06);
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 5px;
      padding: 1px 5px;
      font-size: 0.94em;
    }
    .typed-response {
      display: grid;
      gap: 12px;
    }
    .typed-card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 12px;
      padding: 14px 16px;
    }
    .typed-kicker {
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .typed-answer {
      color: var(--text);
      font-size: 18px;
      font-weight: 750;
      line-height: 1.35;
    }
    .typed-steps {
      margin: 0;
      padding-left: 22px;
    }
    .typed-steps li {
      margin: 7px 0;
    }
    .typed-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .typed-fact {
      border: 1px solid var(--line);
      background: var(--panel-2);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .code-block {
      margin: 12px 0;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      border: 1px solid #1f2430;
      background: #12141c;
      border-radius: 10px;
      overflow: hidden;
    }
    .code-label {
      border-bottom: 1px solid #1f2430;
      padding: 7px 12px;
      color: #8a93a6;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .code-block pre {
      margin: 0;
      padding: 14px;
      max-width: 100%;
      overflow: hidden;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    .code-block code {
      color: #d9edff;
      background: transparent;
      border: 0;
      border-radius: 0;
      padding: 0;
      white-space: inherit;
      overflow-wrap: inherit;
      word-break: inherit;
    }

    .work-trace { display: grid; gap: 12px; }
    .live-sections {
      display: grid;
      gap: 16px;
      margin-bottom: 16px;
    }
    .live-section {
      border-left: 3px solid rgba(124, 108, 246, 0.38);
      padding-left: 14px;
    }
    .live-section h3 {
      margin: 0 0 8px;
      font-size: 14px;
      line-height: 1.35;
    }
    .work-title {
      display: flex;
      align-items: center;
      color: var(--text);
      font-weight: 650;
      font-size: 13px;
    }
    .chunk-list { display: grid; gap: 8px; }
    .chunk-row {
      border: 1px solid var(--line);
      background: var(--panel-2);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .chunk-row.is-active {
      border-color: rgba(124, 108, 246, 0.4);
      box-shadow: 0 0 0 3px rgba(124, 108, 246, 0.08);
    }
    .chunk-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      color: var(--text);
      font-size: 13px;
    }
    .chunk-status {
      color: var(--muted-2);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .chunk-status.is-active {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--cyan);
    }
    .chunk-meta {
      margin-top: 6px;
      color: var(--muted-2);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .chunk-output {
      margin-top: 9px;
      color: #414a5a;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 160px;
      overflow: auto;
      border-top: 1px solid var(--line);
      padding-top: 9px;
      font-size: 13px;
    }
    .mx-spinner {
      width: 12px;
      height: 12px;
      border: 1.5px solid rgba(124, 108, 246, 0.24);
      border-top-color: var(--cyan);
      border-radius: 999px;
      animation: mx-spin 0.72s linear infinite;
      flex: 0 0 auto;
    }
    .thinking-dots {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      margin-left: 8px;
    }
    .thinking-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.25;
      animation: mx-dot 1s ease-in-out infinite;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.14s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.28s; }
    @keyframes mx-spin { to { transform: rotate(360deg); } }
    @keyframes mx-dot {
      0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
      40% { opacity: 1; transform: translateY(-2px); }
    }

    .source-sections {
      margin-top: 16px;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    .source-sections summary {
      cursor: pointer;
      color: var(--muted-2);
      font-size: 12px;
    }
    .citation-sources {
      margin-top: 12px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
      display: grid;
      gap: 6px;
    }
    .citation-sources summary {
      cursor: pointer;
      color: var(--muted-2);
      font-size: 12px;
    }
    .citation-list {
      margin-top: 8px;
      display: grid;
      gap: 6px;
    }
    .citation-row {
      font-size: 12px;
      color: var(--muted);
    }
    .citation-row a {
      color: var(--blue);
      text-decoration: none;
    }
    .citation-row a:hover {
      text-decoration: underline;
    }
    .tool-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 650;
      margin-left: 8px;
    }
    .tool-badge.is-web {
      background: rgba(59, 130, 246, 0.12);
      color: var(--blue);
    }
    .tool-badge.is-wikipedia {
      background: rgba(107, 114, 128, 0.14);
      color: var(--muted);
    }

    form {
      width: min(880px, 100%);
      margin: 0 auto;
      padding: 14px 18px 22px;
    }
    .composer {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #fff;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto auto;
      gap: 8px 10px;
      padding: 14px 16px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
    }
    textarea {
      grid-column: 1;
      min-height: 52px;
      max-height: 180px;
      resize: none;
      border: 0;
      padding: 6px 4px;
      color: var(--text);
      background: transparent;
      font: inherit;
      font-size: 14px;
      outline: none;
    }
    textarea::placeholder { color: var(--muted-2); }
    .composer-actions {
      grid-column: 1;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      color: var(--muted-2);
      font-size: 12px;
    }
    .tool-toggle {
      border: 0;
      background: transparent;
      color: var(--muted-2);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .tool-toggle:hover,
    .tool-toggle:focus-visible {
      color: var(--blue);
      outline: none;
    }
    .tool-toggle.is-active {
      color: var(--green);
    }
    .tool-toggle.is-active .kbd {
      border-color: rgba(18, 184, 134, 0.42);
      background: #e9fbf4;
      color: var(--green);
    }
    .voice-controls {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }
    .voice-button {
      width: 32px;
      height: 32px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      background: #f8f9ff;
      color: var(--muted);
      display: inline-grid;
      place-items: center;
      transition:
        color var(--motion-fast),
        background var(--motion-fast),
        border-color var(--motion-fast),
        transform var(--motion-fast);
    }
    .voice-button svg {
      width: 16px;
      height: 16px;
    }
    .voice-button:hover:not(:disabled),
    .voice-button:focus-visible {
      color: var(--blue);
      border-color: rgba(59, 130, 246, 0.36);
      background: #eef5ff;
      transform: translateY(-1px);
    }
    .voice-button.is-active {
      color: #fff;
      border-color: transparent;
      background: var(--gradient);
      box-shadow: 0 8px 18px rgba(90, 90, 240, 0.26);
    }
    .voice-button.is-listening {
      color: #fff;
      border-color: transparent;
      background: var(--red);
      animation: mx-pulse 1.2s ease-in-out infinite;
    }
    .voice-button:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .voice-status {
      min-width: 92px;
      color: var(--muted-2);
      font-size: 11px;
      white-space: nowrap;
    }
    @keyframes mx-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.36); }
      50% { box-shadow: 0 0 0 8px rgba(229, 72, 77, 0); }
    }
    .kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      margin-right: 6px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #f4f5f9;
      color: var(--muted);
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: 11px;
    }
    .send {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: end;
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 50%;
      color: #fff;
      background: var(--gradient);
      font-weight: 700;
      display: grid;
      place-items: center;
      box-shadow: 0 10px 22px rgba(90, 90, 240, 0.3);
      transition: transform var(--motion-medium), box-shadow var(--motion-medium);
    }
    .send svg { width: 18px; height: 18px; }
    .send:hover:not(:disabled),
    .send:focus-visible {
      transform: translateY(-1px);
      box-shadow: 0 14px 28px rgba(90, 90, 240, 0.4);
    }
    .send:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .fine-print {
      text-align: center;
      color: var(--muted-2);
      font-size: 12px;
      margin-top: 12px;
    }

    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside { display: none; }
      .conversation { padding: 24px 14px 20px; }
      .suggestions { grid-template-columns: 1fr; }
      form { padding: 12px 14px 18px; }
    }
  </style>
</head>
<body>
  <div class="shell" data-control-plane="${escapeHtml(config.controlPlaneUrl)}">
    <aside>
      <div class="brand-block">
        <img class="brand-logo" src="/assets/mundusx-logo.png" alt="" />
        <div>
          <div class="brand-name">MundusX</div>
          <div class="brand-kicker">Decentralized AI Network</div>
        </div>
      </div>
      <div class="network-summary">
        <span class="network-signal"><i class="online-dot"></i><span id="network-state">Checking network</span></span>
      </div>
      <button class="new-chat" id="new-chat" type="button"><span>+ New Chat</span><span class="kbd-hint">&#8984; K</span></button>
      <div class="rail-list" id="history-list" aria-label="Conversation history"></div>
      <div class="rail-footer">
        <div class="network-line"><span><span class="network-dot"></span>MundusX Network</span><span id="network-card-state">Syncing</span></div>
        <div id="network-card-metrics">-- nodes - -- queued - routed</div>
        <div>Latency <span id="network-latency">-- ms</span> - Jobs <span id="network-jobs">--</span></div>
      </div>
      <div class="account-widget">
        <div class="account-menu" id="account-menu">
          <button class="account-menu-header" type="button">
            <span class="account-avatar">LB</span>
            <span class="account-menu-header-text">
              <span class="account-menu-name">Lichard Baliuag</span>
              <span class="account-menu-plan">Free</span>
            </span>
            <span class="chevron">${ICON_CHEVRON_RIGHT}</span>
          </button>
          <div class="account-menu-divider"></div>
          <button class="account-menu-item" type="button">${ICON_UPGRADE}<span>Upgrade plan</span></button>
          <button class="account-menu-item" type="button">${ICON_PERSONALIZATION}<span>Personalization</span></button>
          <button class="account-menu-item" type="button">${ICON_PROFILE}<span>Profile</span></button>
          <button class="account-menu-item" type="button">${ICON_SETTINGS}<span>Settings</span></button>
          <div class="account-menu-divider"></div>
          <button class="account-menu-item" type="button">${ICON_HELP_RING}<span>Help</span><span class="chevron">${ICON_CHEVRON_RIGHT}</span></button>
          <button class="account-menu-item" type="button">${ICON_LOGOUT}<span>Log out</span></button>
        </div>
        <button class="account-bar" id="account-bar" type="button" aria-haspopup="true" aria-expanded="false">
          <span class="account-avatar">LB</span>
          <span class="account-info">
            <span class="account-name">Lichard Baliuag</span>
            <span class="account-plan">Free</span>
          </span>
          <span class="account-upgrade">Upgrade</span>
        </button>
      </div>
    </aside>
    <main>
      <header>
        <span class="runtime-status-sentinel" id="runtime-status" data-state="ready"><span class="status-dot"></span><span id="runtime-status-text">Ready</span></span>
      </header>
      <section class="messages" id="messages" aria-live="polite">
        <div class="conversation" id="conversation">
          <div class="welcome" id="welcome">
            ${WELCOME_INNER_HTML}
          </div>
        </div>
      </section>
      <form id="chat-form">
        <div class="composer">
          <textarea id="prompt" name="prompt" placeholder="Ask everyone..." autocomplete="off" required></textarea>
          <div class="composer-actions">
            <button class="tool-toggle" id="web-search-toggle" type="button" aria-pressed="false" title="Use grounded tools when available"><span class="kbd">@</span><span id="web-search-label">Web Search</span></button>
            <button class="tool-toggle" id="enter-to-send-toggle" type="button" aria-pressed="false" title="Toggle sending messages with Enter"><span class="kbd">&#8629;</span><span id="enter-to-send-label">Enter to Send</span></button>
            <span class="voice-controls" id="voice-controls">
              <button class="voice-button" id="voice-mic" type="button" aria-label="Start voice input" title="Voice input">${ICON_MIC}</button>
              <button class="voice-button" id="voice-speak" type="button" aria-label="Speak replies" aria-pressed="false" title="Speak replies">${ICON_VOLUME}</button>
              <span class="voice-status" id="voice-status">Voice ready</span>
            </span>
          </div>
          <button class="send" id="send" type="submit" aria-label="Send">${ICON_ARROW_UP}</button>
        </div>
        <div class="fine-print">MundusX may produce inaccurate information.</div>
      </form>
    </main>
  </div>
  <script>
    const form = document.getElementById("chat-form");
    const promptEl = document.getElementById("prompt");
    const sendEl = document.getElementById("send");
    const messagesEl = document.getElementById("conversation");
    const statusEl = document.getElementById("runtime-status");
    const statusTextEl = document.getElementById("runtime-status-text");
    const historyListEl = document.getElementById("history-list");
    const newChatEl = document.getElementById("new-chat");
    const accountBarEl = document.getElementById("account-bar");
    const accountMenuEl = document.getElementById("account-menu");
    const webSearchToggleEl = document.getElementById("web-search-toggle");
    const webSearchLabelEl = document.getElementById("web-search-label");
    const enterToSendToggleEl = document.getElementById("enter-to-send-toggle");
    const enterToSendLabelEl = document.getElementById("enter-to-send-label");
    const voiceMicEl = document.getElementById("voice-mic");
    const voiceSpeakEl = document.getElementById("voice-speak");
    const voiceStatusEl = document.getElementById("voice-status");
    const historyKey = "mundusx.chat.history.v1";
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let isListening = false;
    let heardSpeech = false;
    let voiceStopReason = "idle";
    let voiceSilenceTimer = null;
    let voiceHardStopTimer = null;
    let voiceMicStream = null;
    let speakReplies = localStorage.getItem("mundusx.chat.voice.speakReplies") === "true";
    let webSearchEnabled = localStorage.getItem("mundusx.chat.toolMode") === "true";
    let enterToSendEnabled = localStorage.getItem("mundusx.chat.enterToSend") !== "false";

    renderHistory();
    hydrateNetwork();
    renderToolMode();
    renderEnterToSend();
    setupVoiceControls();
    setInterval(hydrateNetwork, 15000);

    accountBarEl?.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = accountMenuEl.classList.toggle("is-open");
      accountBarEl.setAttribute("aria-expanded", String(isOpen));
    });
    document.addEventListener("click", (event) => {
      if (!accountMenuEl?.classList.contains("is-open")) return;
      if (event.target.closest(".account-widget")) return;
      accountMenuEl.classList.remove("is-open");
      accountBarEl?.setAttribute("aria-expanded", "false");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      accountMenuEl?.classList.remove("is-open");
      accountBarEl?.setAttribute("aria-expanded", "false");
    });
    webSearchToggleEl?.addEventListener("click", () => {
      webSearchEnabled = !webSearchEnabled;
      localStorage.setItem("mundusx.chat.toolMode", String(webSearchEnabled));
      renderToolMode();
      promptEl.focus();
    });
    enterToSendToggleEl?.addEventListener("click", () => {
      enterToSendEnabled = !enterToSendEnabled;
      localStorage.setItem("mundusx.chat.enterToSend", String(enterToSendEnabled));
      renderEnterToSend();
      promptEl.focus();
    });
    promptEl?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      if (!enterToSendEnabled) return;
      event.preventDefault();
      form.requestSubmit();
    });

    function addMessage(text, role, meta) {
      document.getElementById("welcome")?.remove();
      const node = document.createElement("div");
      node.className = "message" + (role ? " " + role : "");
      node.setAttribute("aria-label", role === "user" ? "Your message" : "MundusX response");
      const body = document.createElement("div");
      body.className = "message-body";
      body.textContent = text;
      if (meta) {
        const metaNode = document.createElement("div");
        metaNode.className = "meta";
        metaNode.textContent = meta;
        body.appendChild(metaNode);
      }
      node.appendChild(body);
      messagesEl.appendChild(node);
      document.getElementById("messages").scrollTop = document.getElementById("messages").scrollHeight;
      return node;
    }

    document.querySelectorAll(".suggestion").forEach((button) => {
      button.addEventListener("click", () => {
        promptEl.value = (button.querySelector(".suggestion-text") ?? button).textContent.trim();
        promptEl.focus();
      });
    });

    function setStatus(state, label) {
      statusEl.dataset.state = state;
      statusTextEl.textContent = label;
    }

    function renderToolMode() {
      if (!webSearchToggleEl || !webSearchLabelEl) return;
      webSearchToggleEl.classList.toggle("is-active", webSearchEnabled);
      webSearchToggleEl.setAttribute("aria-pressed", String(webSearchEnabled));
      webSearchLabelEl.textContent = webSearchEnabled ? "Tools On" : "Web Search";
    }

    function renderEnterToSend() {
      if (!enterToSendToggleEl || !enterToSendLabelEl) return;
      enterToSendToggleEl.classList.toggle("is-active", enterToSendEnabled);
      enterToSendToggleEl.setAttribute("aria-pressed", String(enterToSendEnabled));
      enterToSendLabelEl.textContent = enterToSendEnabled ? "Enter to Send" : "Enter to Send: Off";
    }

    function setupVoiceControls() {
      if (!voiceMicEl || !voiceSpeakEl || !voiceStatusEl) return;
      const canListen = Boolean(SpeechRecognitionCtor);
      const canSpeak = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
      const silenceTimeoutMs = 4000;
      const hardStopTimeoutMs = 60000;

      voiceMicEl.disabled = !canListen;
      voiceSpeakEl.disabled = !canSpeak;
      voiceSpeakEl.classList.toggle("is-active", speakReplies && canSpeak);
      voiceSpeakEl.setAttribute("aria-pressed", String(speakReplies && canSpeak));
      voiceStatusEl.textContent = canListen || canSpeak ? "Voice ready" : "Voice unavailable";

      if (canListen) {
        recognition = new SpeechRecognitionCtor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang = navigator.language || "en-US";
        const clearVoiceTimers = () => {
          if (voiceSilenceTimer) window.clearTimeout(voiceSilenceTimer);
          if (voiceHardStopTimer) window.clearTimeout(voiceHardStopTimer);
          voiceSilenceTimer = null;
          voiceHardStopTimer = null;
        };
        const releaseVoiceMic = () => {
          if (!voiceMicStream) return;
          voiceMicStream.getTracks().forEach((track) => track.stop());
          voiceMicStream = null;
        };
        const stopRecognition = (reason) => {
          if (!recognition || !isListening) return;
          voiceStopReason = reason;
          clearVoiceTimers();
          try {
            recognition.stop();
          } catch {
            releaseVoiceMic();
          }
        };
        const resetSilenceTimer = () => {
          if (!isListening) return;
          if (voiceSilenceTimer) window.clearTimeout(voiceSilenceTimer);
          voiceSilenceTimer = window.setTimeout(() => stopRecognition("silence"), silenceTimeoutMs);
        };
        recognition.addEventListener("audiostart", () => {
          voiceStatusEl.textContent = "Mic allowed";
        });
        recognition.addEventListener("speechstart", () => {
          heardSpeech = true;
          voiceStatusEl.textContent = "Hearing speech";
          resetSilenceTimer();
        });
        recognition.addEventListener("speechend", () => {
          voiceStatusEl.textContent = "Waiting for more speech";
          resetSilenceTimer();
        });
        recognition.addEventListener("start", () => {
          isListening = true;
          heardSpeech = false;
          voiceStopReason = "listening";
          voiceMicEl.classList.add("is-listening");
          voiceMicEl.setAttribute("aria-label", "Stop voice input");
          voiceStatusEl.textContent = "Listening";
          setStatus("working", "Listening");
          resetSilenceTimer();
          voiceHardStopTimer = window.setTimeout(() => stopRecognition("timeout"), hardStopTimeoutMs);
        });
        recognition.addEventListener("result", (event) => {
          const transcriptParts = [];
          for (let i = 0; i < event.results.length; i += 1) {
            const part = event.results[i][0]?.transcript ?? "";
            if (part.trim()) {
              transcriptParts.push(part.trim());
            }
          }
          promptEl.value = transcriptParts.join(" ").replace(/\s+/g, " ").trim();
          voiceStatusEl.textContent = promptEl.value.trim() ? "Transcript ready" : "Listening";
          resetSilenceTimer();
        });
        recognition.addEventListener("nomatch", () => {
          voiceStatusEl.textContent = "No speech matched";
          resetSilenceTimer();
        });
        recognition.addEventListener("end", () => {
          isListening = false;
          clearVoiceTimers();
          releaseVoiceMic();
          voiceMicEl.classList.remove("is-listening");
          voiceMicEl.setAttribute("aria-label", "Start voice input");
          voiceStatusEl.textContent = promptEl.value.trim()
            ? "Transcript ready"
            : voiceStopReason === "timeout"
              ? "Voice limit reached"
            : heardSpeech
              ? "No transcript"
              : "No speech heard";
          voiceStopReason = "idle";
          setStatus("ready", "Ready");
        });
        recognition.addEventListener("error", (event) => {
          isListening = false;
          clearVoiceTimers();
          releaseVoiceMic();
          voiceMicEl.classList.remove("is-listening");
          voiceStatusEl.textContent =
            event.error === "not-allowed"
              ? "Mic blocked"
              : event.error === "no-speech"
                ? "No speech heard"
                : "Voice error";
          setStatus("error", "Voice error");
        });
      }

      voiceMicEl.addEventListener("click", async () => {
        if (!recognition) return;
        if (isListening) {
          voiceStopReason = "manual";
          recognition.stop();
          return;
        }
        if (!window.isSecureContext) {
          voiceStatusEl.textContent = "HTTPS required";
          setStatus("error", "Voice error");
          return;
        }
        try {
          if (navigator.mediaDevices?.getUserMedia) {
            voiceMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            voiceStatusEl.textContent = "Mic allowed";
          }
          promptEl.value = "";
          recognition.start();
        } catch (error) {
          const name = error?.name || "";
          voiceStatusEl.textContent =
            name === "NotAllowedError" || name === "SecurityError" ? "Mic blocked" : "Voice busy";
          setStatus("error", "Voice error");
        }
      });

      voiceSpeakEl.addEventListener("click", () => {
        if (!canSpeak) return;
        speakReplies = !speakReplies;
        localStorage.setItem("mundusx.chat.voice.speakReplies", String(speakReplies));
        voiceSpeakEl.classList.toggle("is-active", speakReplies);
        voiceSpeakEl.setAttribute("aria-pressed", String(speakReplies));
        voiceStatusEl.textContent = speakReplies ? "Replies on" : "Replies off";
        if (!speakReplies) window.speechSynthesis.cancel();
      });
    }

    function speakAssistantReply(text) {
      if (!speakReplies || !("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
      const spoken = normalizeSpokenText(text);
      if (!spoken) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spoken);
      const preferredVoice = selectSpokenVoice();
      if (preferredVoice) {
        utterance.voice = preferredVoice;
        utterance.lang = preferredVoice.lang || utterance.lang;
      }
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.addEventListener("start", () => {
        voiceStatusEl && (voiceStatusEl.textContent = preferredVoice ? "Speaking with Atlas" : "Speaking");
      });
      utterance.addEventListener("end", () => {
        voiceStatusEl && (voiceStatusEl.textContent = "Voice ready");
      });
      utterance.addEventListener("error", () => {
        voiceStatusEl && (voiceStatusEl.textContent = "Voice error");
      });
      window.speechSynthesis.speak(utterance);
    }

    function sortedSpeechVoices() {
      if (!("speechSynthesis" in window)) return [];
      const voices = window.speechSynthesis.getVoices();
      if (!Array.isArray(voices)) return [];
      return voices.slice().sort((a, b) => a.name.localeCompare(b.name));
    }

    function selectSpokenVoice() {
      if (!("speechSynthesis" in window)) return null;
      const voices = window.speechSynthesis.getVoices();
      if (!Array.isArray(voices) || voices.length === 0) return null;
      return selectAtlasVoice() || voices.find((voice) => /^en/i.test(voice.lang || "")) || voices[0] || null;
    }

    function selectAtlasVoice() {
      if (!("speechSynthesis" in window)) return null;
      const voices = window.speechSynthesis.getVoices();
      if (!Array.isArray(voices) || voices.length === 0) return null;
      const preferredNames = [
        "Microsoft David",
        "Microsoft Mark",
        "Microsoft Guy",
        "Microsoft George",
        "Microsoft Ryan",
        "Microsoft Christopher",
        "Google UK English Male",
        "Male",
      ];
      for (const preferredName of preferredNames) {
        const match = voices.find((voice) =>
          voice.name.toLowerCase().includes(preferredName.toLowerCase()),
        );
        if (match) return match;
      }
      return null;
    }

    function selectedAssistantPersona() {
      return "atlas";
    }

    function normalizeSpokenText(text) {
      return String(text || "")
        .replace(new RegExp(String.fromCharCode(96, 96, 96) + "[\\\\s\\\\S]*?" + String.fromCharCode(96, 96, 96), "g"), " code block omitted. ")
        .replace(new RegExp(String.fromCharCode(96) + "([^" + String.fromCharCode(96) + "]+)" + String.fromCharCode(96), "g"), "$1")
        .replace(/https?:\\/\\/\\S+/g, " link omitted ")
        .replace(/[#*_>\\[\\]()]/g, " ")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 1200);
    }

    newChatEl?.addEventListener("click", () => {
      messagesEl.querySelectorAll(".message").forEach((node) => node.remove());
      if (!document.getElementById("welcome")) {
        messagesEl.prepend(createWelcome());
      }
      promptEl.value = "";
      promptEl.focus();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = promptEl.value.trim();
      if (!message) return;

      saveHistory(message);
      addMessage(message, "user");
      promptEl.value = "";
      sendEl.disabled = true;
      setStatus("working", "Working");
      const pending = addMessage("Submitting to MundusX...", "assistant", "Queued");

      try {
        const created = await fetch("/api/chat/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, executionMode: "auto", voicePersona: selectedAssistantPersona(), toolMode: webSearchEnabled }),
        });
        const submitted = await created.json();
        if (!created.ok) {
          throw new Error(submitted.error || "chat request failed");
        }

        renderPendingJob(pending, submitted);
        let payload = submitted;
        while (!["completed", "failed"].includes(payload.status)) {
          await sleep(1500);
          const polled = await fetch("/api/chat/jobs/" + encodeURIComponent(submitted.job_id));
          payload = await polled.json();
          if (!polled.ok) {
            throw new Error(payload.error || "chat poll failed");
          }
          renderPendingJob(pending, payload);
        }

        if (payload.status === "failed") {
          throw new Error(payload.error || "MundusX job failed");
        }

        renderCompletedJob(pending, payload);
        setStatus("ready", "Ready");
      } catch (error) {
        pending.className = "message error";
        const body = pending.querySelector(".message-body");
        body.textContent = error.message;
        setStatus("error", "Error");
      } finally {
        sendEl.disabled = false;
        promptEl.focus();
      }
    });

    function renderPendingJob(node, payload) {
      const body = node.querySelector(".message-body");
      body.textContent = "";
      const liveSections = createLiveSections(payload);
      if (liveSections) {
        body.appendChild(liveSections);
      }
      body.appendChild(createWorkTrace(payload));
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatJobMeta(payload);
      body.appendChild(meta);
    }

    function renderCompletedJob(node, payload) {
      const body = node.querySelector(".message-body");
      const userPrompt = findPreviousUserMessage(node);
      const output = stripEchoedPrompt(payload.output || "(empty response)", userPrompt);
      body.textContent = "";
      if (payload.response) {
        body.appendChild(renderTypedResponse(payload.response));
      } else {
        appendRichMessage(body, output);
      }
      if (shouldShowSourceSections(payload)) {
        body.appendChild(createSourceSections(payload));
      }
      if (Array.isArray(payload.sources) && payload.sources.length) {
        body.appendChild(createCitationSources(payload.sources));
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatJobMeta(payload);
      const badge = createToolBadge(payload);
      if (badge) {
        meta.appendChild(badge);
      }
      body.appendChild(meta);
      speakAssistantReply(spokenTextForPayload(payload, output));
    }

    function createCitationSources(sources) {
      const details = document.createElement("details");
      details.className = "citation-sources";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = "Sources (" + sources.length + ")";
      details.appendChild(summary);
      const list = document.createElement("div");
      list.className = "citation-list";
      sources.forEach((source, index) => {
        const row = document.createElement("div");
        row.className = "citation-row";
        const link = document.createElement("a");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "[" + (index + 1) + "] " + (source.title || source.url);
        row.appendChild(link);
        list.appendChild(row);
      });
      details.appendChild(list);
      return details;
    }

    function createToolBadge(payload) {
      if (payload.tool === "web_search") {
        const badge = document.createElement("span");
        badge.className = "tool-badge is-web";
        badge.textContent = "Web";
        return badge;
      }
      if (payload.tool === "factual_summary") {
        const badge = document.createElement("span");
        badge.className = "tool-badge is-wikipedia";
        badge.textContent = "Wikipedia";
        return badge;
      }
      return null;
    }

    function spokenTextForPayload(payload, fallbackOutput) {
      const response = payload.response;
      if (response?.answer) return response.answer;
      if (response?.summary) return response.summary;
      if (typeof response?.text === "string") return response.text;
      return fallbackOutput;
    }

    function renderTypedResponse(response) {
      const wrapper = document.createElement("div");
      wrapper.className = "typed-response";
      if (response.type === "math_solution") {
        wrapper.appendChild(createTypedCard(response.title || "Math solution", response.answer));
        if (Array.isArray(response.steps) && response.steps.length) {
          const stepsCard = document.createElement("div");
          stepsCard.className = "typed-card";
          const kicker = document.createElement("div");
          kicker.className = "typed-kicker";
          kicker.textContent = "Steps";
          stepsCard.appendChild(kicker);
          const list = document.createElement("ol");
          list.className = "typed-steps";
          for (const step of response.steps) {
            const item = document.createElement("li");
            item.textContent = step;
            list.appendChild(item);
          }
          stepsCard.appendChild(list);
          wrapper.appendChild(stepsCard);
        }
        return wrapper;
      }
      if (response.type === "weather_result") {
        wrapper.appendChild(createTypedCard(response.title || "Weather", response.summary));
        const facts = Object.entries(response.facts || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
        if (facts.length) {
          const factWrap = document.createElement("div");
          factWrap.className = "typed-facts";
          for (const [key, value] of facts) {
            const fact = document.createElement("span");
            fact.className = "typed-fact";
            fact.textContent = key + ": " + value;
            factWrap.appendChild(fact);
          }
          wrapper.appendChild(factWrap);
        }
        return wrapper;
      }
      appendRichMessage(wrapper, response.text || "");
      return wrapper;
    }

    function createTypedCard(kickerText, answerText) {
      const card = document.createElement("div");
      card.className = "typed-card";
      const kicker = document.createElement("div");
      kicker.className = "typed-kicker";
      kicker.textContent = kickerText;
      const answer = document.createElement("div");
      answer.className = "typed-answer";
      answer.textContent = answerText || "";
      card.appendChild(kicker);
      card.appendChild(answer);
      return card;
    }

    function createLiveSections(payload) {
      const sections = completedDisplaySections(payload);
      if (!sections.length) return null;
      const wrapper = document.createElement("div");
      wrapper.className = "live-sections";
      for (const section of sections) {
        const article = document.createElement("section");
        article.className = "live-section";
        const heading = document.createElement("h3");
        heading.textContent = section.name;
        article.appendChild(heading);
        appendRichMessage(article, section.output);
        wrapper.appendChild(article);
      }
      return wrapper;
    }

    function completedDisplaySections(payload) {
      const nodes = payload.progress?.nodes || [];
      return nodes
        .filter((node) => node.status === "completed")
        .filter((node) => String(node.responsibility || "section") !== "merge")
        .filter((node) => String(node.output || "").trim())
        .map((node) => ({
          name: node.name || node.id || "Section",
          output: String(node.output || "").trim(),
        }));
    }

    function findPreviousUserMessage(node) {
      let cursor = node.previousElementSibling;
      while (cursor) {
        if (cursor.classList.contains("user")) {
          return cursor.querySelector(".message-body")?.textContent?.trim() || "";
        }
        cursor = cursor.previousElementSibling;
      }
      return "";
    }

    function stripEchoedPrompt(output, prompt) {
      let text = String(output || "").trim();
      const originalPrompt = String(prompt || "").trim();
      if (!text || !originalPrompt) return text;
      if (text.toLowerCase().startsWith(originalPrompt.toLowerCase())) {
        text = text.slice(originalPrompt.length).trim();
      }
      text = text
        .replace(/^please provide the complete code for this program\\.?\\s*/i, "")
        .replace(/^here(?:'s| is)\\s+(?:the\\s+)?(?:complete\\s+)?(?:code|program)[:.\\s-]*/i, "")
        .trim();
      return text || output;
    }

    function appendRichMessage(container, text) {
      const parts = splitMarkdownCode(String(text || ""));
      if (!parts.some((part) => part.type === "code") && looksLikeCode(text)) {
        container.appendChild(createCodeBlock("code", formatCodeForDisplay(text)));
        return;
      }
      for (const part of parts) {
        if (part.type === "code") {
          container.appendChild(createCodeBlock(part.language, formatCodeForDisplay(part.value)));
        } else {
          appendTextParagraphs(container, part.value);
        }
      }
    }

    function splitMarkdownCode(text) {
      const parts = [];
      const fence = String.fromCharCode(96).repeat(3);
      let index = 0;
      while (index < text.length) {
        const start = text.indexOf(fence, index);
        if (start === -1) break;
        if (start > index) {
          parts.push({ type: "text", value: text.slice(index, start) });
        }
        const contentStart = start + fence.length;
        const end = text.indexOf(fence, contentStart);
        if (end === -1) break;
        const raw = text.slice(contentStart, end).replace(/^\\n/, "");
        const firstBreak = raw.indexOf("\\n");
        const firstLine = firstBreak === -1 ? "" : raw.slice(0, firstBreak).trim();
        const hasLanguage = /^[a-zA-Z0-9_+#.-]{1,24}$/.test(firstLine);
        parts.push({
          type: "code",
          language: hasLanguage ? firstLine : "code",
          value: hasLanguage ? raw.slice(firstBreak + 1) : raw,
        });
        index = end + fence.length;
      }
      if (index < text.length) {
        parts.push({ type: "text", value: text.slice(index) });
      }
      return parts.length ? parts : [{ type: "text", value: text }];
    }

    function appendTextParagraphs(container, text) {
      const blocks = normalizeAssistantDisplayText(text).split(/\\n{2,}/).filter(Boolean);
      for (const block of blocks) {
        const list = createListBlock(block);
        if (list) {
          container.appendChild(list);
          continue;
        }
        const node = document.createElement("p");
        appendInlineMarkdown(node, block.trim());
        container.appendChild(node);
      }
    }

    function normalizeAssistantDisplayText(text) {
      return String(text || "")
        .replace(/\\r\\n/g, "\\n")
        .replace(/\\s+(\\d+)\\.\\s+(?=\\*\\*|[A-Z0-9])/g, "\\n$1. ")
        .replace(/\\s+[-*]\\s+(?=\\*\\*|[A-Z0-9])/g, "\\n- ")
        .replace(/\\n{3,}/g, "\\n\\n")
        .trim();
    }

    function createListBlock(block) {
      const lines = String(block || "").split("\\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length < 2) return null;
      const ordered = lines.every((line) => /^\\d+\\.\\s+/.test(line));
      const unordered = lines.every((line) => /^[-*]\\s+/.test(line));
      if (!ordered && !unordered) return null;
      const list = document.createElement(ordered ? "ol" : "ul");
      for (const line of lines) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, line.replace(ordered ? /^\\d+\\.\\s+/ : /^[-*]\\s+/, ""));
        list.appendChild(item);
      }
      return list;
    }

    function appendInlineMarkdown(parent, text) {
      const value = String(text || "");
      const tick = String.fromCharCode(96);
      const pattern = new RegExp("(\\\\*\\\\*[^*]+\\\\*\\\\*|" + tick + "[^" + tick + "]+" + tick + ")", "g");
      let index = 0;
      for (const match of value.matchAll(pattern)) {
        if (match.index > index) {
          parent.appendChild(document.createTextNode(value.slice(index, match.index)));
        }
        const token = match[0];
        const node = document.createElement(token.startsWith("**") ? "strong" : "code");
        node.textContent = token.startsWith("**") ? token.slice(2, -2) : token.slice(1, -1);
        parent.appendChild(node);
        index = match.index + token.length;
      }
      if (index < value.length) {
        parent.appendChild(document.createTextNode(value.slice(index)));
      }
    }

    function createCodeBlock(language, code) {
      const wrapper = document.createElement("div");
      wrapper.className = "code-block";
      const label = document.createElement("div");
      label.className = "code-label";
      label.textContent = language || "code";
      const pre = document.createElement("pre");
      const codeNode = document.createElement("code");
      codeNode.textContent = code;
      pre.appendChild(codeNode);
      wrapper.appendChild(label);
      wrapper.appendChild(pre);
      return wrapper;
    }

    function looksLikeCode(text) {
      const value = String(text || "");
      return /\\b(public\\s+class|class\\s+\\w+|import\\s+java\\.|#include\\s*<|function\\s+\\w+\\s*\\(|const\\s+\\w+\\s*=|def\\s+\\w+\\s*\\()/m.test(value) &&
        (value.match(/[;{}]/g) || []).length >= 4;
    }

    function formatCodeForDisplay(code) {
      const raw = String(code || "").trim();
      if (raw.includes("\\n")) return raw;
      let formatted = raw
        .replace(/\\s*;\\s*/g, ";\\n")
        .replace(/\\s*\\{\\s*/g, " {\\n")
        .replace(/\\s*\\}\\s*/g, "\\n}\\n")
        .replace(/\\n{2,}/g, "\\n")
        .trim();
      const lines = formatted.split("\\n");
      let depth = 0;
      return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return "";
        if (trimmed.startsWith("}")) depth = Math.max(0, depth - 1);
        const out = "  ".repeat(depth) + trimmed;
        if (trimmed.endsWith("{")) depth += 1;
        return out;
      }).join("\\n");
    }

    function createWorkTrace(payload) {
      const progress = payload.progress || {};
      const wrapper = document.createElement("div");
      wrapper.className = "work-trace";
      const title = document.createElement("div");
      title.className = "work-title";
      title.textContent = formatProgressText(payload);
      if (!["completed", "failed"].includes(payload.status)) {
        title.appendChild(createThinkingDots());
      }
      wrapper.appendChild(title);

      if (progress.nodes?.length) {
        const list = document.createElement("div");
        list.className = "chunk-list";
        for (const chunk of progress.nodes) {
          list.appendChild(createChunkRow(chunk));
        }
        wrapper.appendChild(list);
      }

      return wrapper;
    }

    function shouldShowSourceSections(payload) {
      return Boolean(payload.progress?.final_synthesis) &&
        payload.progress?.nodes?.some((chunk) => chunk.output);
    }

    function createSourceSections(payload) {
      const details = document.createElement("details");
      details.className = "source-sections";
      const summary = document.createElement("summary");
      summary.textContent = "Completed source sections";
      details.appendChild(summary);
      const list = document.createElement("div");
      list.className = "chunk-list";
      for (const chunk of payload.progress.nodes.filter((node) => node.output)) {
        list.appendChild(createChunkRow(chunk));
      }
      details.appendChild(list);
      return details;
    }

    function createChunkRow(chunk) {
      const row = document.createElement("div");
      const statusText = formatChunkStatusText(chunk);
      const active = isActiveChunkStatus(chunk.status);
      row.className = "chunk-row" + (active ? " is-active" : "");
      const head = document.createElement("div");
      head.className = "chunk-head";
      const name = document.createElement("span");
      name.textContent = chunk.name || chunk.id || "Chunk";
      const status = document.createElement("span");
      status.className = "chunk-status" + (active ? " is-active" : "");
      if (active) {
        const spinner = document.createElement("span");
        spinner.className = "mx-spinner";
        spinner.setAttribute("aria-hidden", "true");
        status.appendChild(spinner);
      }
      status.appendChild(document.createTextNode(statusText));
      head.appendChild(name);
      head.appendChild(status);
      row.appendChild(head);
      const telemetry = formatChunkTelemetry(chunk);
      if (telemetry) {
        const meta = document.createElement("div");
        meta.className = "chunk-meta";
        meta.textContent = telemetry;
        row.appendChild(meta);
      }
      if (chunk.output) {
        const output = document.createElement("div");
        output.className = "chunk-output";
        appendRichMessage(output, chunk.output);
        row.appendChild(output);
      }
      return row;
    }

    function formatChunkStatusText(chunk) {
      if (String(chunk.status || "").toLowerCase() === "waiting" && chunk.blocked_by?.length) {
        return "blocked";
      }
      return chunk.status || "waiting";
    }

    function formatChunkTelemetry(chunk) {
      const parts = [];
      if (chunk.assigned_node_id) parts.push("node " + chunk.assigned_node_id);
      if (chunk.blocked_by?.length) parts.push("blocked by " + chunk.blocked_by.join(", "));
      else if (chunk.depends_on?.length) parts.push("depends on " + chunk.depends_on.join(", "));
      if (Number.isFinite(chunk.latency_ms)) parts.push("latency " + chunk.latency_ms + " ms");
      if (Number.isFinite(chunk.queue_wait_ms)) parts.push("queue " + chunk.queue_wait_ms + " ms");
      if (Number.isFinite(chunk.output_chars)) parts.push(chunk.output_chars + " chars");
      if (Number.isFinite(chunk.effective_max_tokens)) parts.push("max " + chunk.effective_max_tokens + " tokens");
      return parts.join(" - ");
    }

    function isActiveChunkStatus(status) {
      return ["assigned", "running", "processing", "merging"]
        .includes(String(status || "").toLowerCase());
    }

    function createThinkingDots() {
      const dots = document.createElement("span");
      dots.className = "thinking-dots";
      dots.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 3; index += 1) {
        dots.appendChild(document.createElement("span"));
      }
      return dots;
    }

    function formatProgressText(payload) {
      const progress = payload.progress || {};
      if (payload.status === "completed") {
        return progress.final_synthesis ? "Final answer ready." : "Sections ready.";
      }
      if (progress.merging) return "Merging final synthesis...";
      if (progress.processing) return "Processing: " + progress.processing;
      if (progress.total) {
        return "Queued " + progress.completed + "/" + progress.total + " " + progressUnit(progress) + " complete.";
      }
      return "Queued with MundusX...";
    }

    function formatJobMeta(payload) {
      const progress = payload.progress || {};
      const units = progress.total ? " / " + progress.completed + "/" + progress.total + " " + progressUnit(progress) : "";
      return "job " + payload.job_id + " / " + payload.status + " / mode " + payload.execution_mode + units;
    }

    function progressUnit(progress) {
      return progress.strategy === "sectioned_research" && !progress.final_synthesis ? "sections" : "chunks";
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function hydrateNetwork() {
      const started = performance.now();
      try {
        const response = await fetch("/api/network");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "network unavailable");
        const latency = Math.max(1, Math.round(performance.now() - started));
        const summary = document.querySelector(".network-summary");
        summary?.classList.toggle("is-online", payload.online_count > 0);
        summary?.classList.toggle("is-waiting", payload.online_count === 0);
        summary?.classList.remove("is-offline");
        setText("network-state", payload.online_count > 0 ? "Online - nodes ready" : "Standby - no ready nodes");
        setText("network-card-state", payload.online_count > 0 ? "ONLINE" : "WAITING");
        setText("network-card-metrics", payload.online_count + " nodes - " + payload.queued_job_count + " queued - " + payload.model_routing);
        setText("network-latency", latency + " ms");
        setText("network-jobs", payload.completed_job_count + " completed");
      } catch {
        const summary = document.querySelector(".network-summary");
        summary?.classList.remove("is-online", "is-waiting");
        summary?.classList.add("is-offline");
        setText("network-state", "Control plane offline");
        setText("network-card-state", "OFFLINE");
        setText("network-card-metrics", "control plane unavailable");
        setText("network-latency", "-- ms");
        setText("network-jobs", "--");
      }
    }

    function saveHistory(message) {
      const items = readHistory();
      const now = Date.now();
      const next = [
        { id: String(now), title: message.slice(0, 72), createdAt: now },
        ...items.filter((item) => item.title !== message).slice(0, 29),
      ];
      localStorage.setItem(historyKey, JSON.stringify(next));
      renderHistory();
    }

    function readHistory() {
      try {
        const items = JSON.parse(localStorage.getItem(historyKey) || "[]");
        return Array.isArray(items) ? items : [];
      } catch {
        return [];
      }
    }

    function renderHistory() {
      const items = readHistory();
      historyListEl.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.innerHTML =
          '<div class="history-empty-icon">${ICON_CHAT_BUBBLE}</div>' +
          '<div class="history-empty-title">No conversations yet</div>' +
          '<div class="history-empty-copy">Start a new chat to begin.</div>';
        historyListEl.appendChild(empty);
        return;
      }
      for (const [label, groupItems] of groupHistory(items)) {
        const group = document.createElement("div");
        group.className = "history-group";
        const heading = document.createElement("div");
        heading.className = "history-label";
        heading.textContent = label;
        group.appendChild(heading);
        for (const item of groupItems) {
          const row = document.createElement("button");
          row.className = "history-item";
          row.type = "button";
          row.innerHTML = "<span class='history-title'></span><span class='history-time'></span>";
          row.children[0].textContent = item.title || "Untitled";
          row.children[1].textContent = formatHistoryTime(item.createdAt);
          row.addEventListener("click", () => {
            promptEl.value = item.title || "";
            promptEl.focus();
          });
          group.appendChild(row);
        }
        historyListEl.appendChild(group);
      }
    }

    function groupHistory(items) {
      const today = [];
      const yesterday = [];
      const older = [];
      const startToday = new Date();
      startToday.setHours(0, 0, 0, 0);
      const startYesterday = startToday.getTime() - 86400000;
      for (const item of items) {
        if (item.createdAt >= startToday.getTime()) today.push(item);
        else if (item.createdAt >= startYesterday) yesterday.push(item);
        else older.push(item);
      }
      return [
        ["Today", today],
        ["Yesterday", yesterday],
        ["Previous", older],
      ].filter(([, groupItems]) => groupItems.length);
    }

    function formatHistoryTime(value) {
      const date = new Date(value);
      const startToday = new Date();
      startToday.setHours(0, 0, 0, 0);
      if (value >= startToday.getTime()) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }

    function setText(id, value) {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    }

    function createWelcome() {
      const wrapper = document.createElement("div");
      wrapper.className = "welcome";
      wrapper.id = "welcome";
      wrapper.innerHTML = ${JSON.stringify(WELCOME_INNER_HTML)};
      wrapper.querySelectorAll(".suggestion").forEach((button) => {
        button.addEventListener("click", () => {
          promptEl.value = (button.querySelector(".suggestion-text") ?? button).textContent.trim();
          promptEl.focus();
        });
      });
      return wrapper;
    }
  </script>
</body>
</html>`;
}

export function createServerApp(config = configFromEnv()) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        return sendHtml(response, page(config));
      }
      if (request.method === "GET" && url.pathname === "/assets/mundusx-logo.png") {
        return sendPng(response, await readFile(LOGO_PATH));
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          status: "ok",
          control_plane_url: config.controlPlaneUrl,
          model_routing: "control-plane",
          model_override: config.modelOverride || null,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/network") {
        const result = await fetchNetworkSummary(config);
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonBody(request);
        const result = await submitChatTurn(body, config);
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/chat/jobs") {
        const body = await readJsonBody(request);
        const result = await submitChatJob(body, config);
        return sendJson(response, 202, result);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/chat/jobs/")) {
        const jobId = decodeURIComponent(url.pathname.slice("/api/chat/jobs/".length));
        const result = await pollChatJob(jobId, config);
        return sendJson(response, 200, result);
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const status = error.statusCode ?? 500;
      return sendJson(response, status, { error: error.message ?? "request failed" });
    }
  });
}

export async function submitChatTurn(body, config = configFromEnv(), fetchImpl = fetch) {
  const submitted = await submitChatJob(body, config, fetchImpl);
  if (["completed", "failed"].includes(submitted.status)) {
    return submitted;
  }
  return waitForChatJob(submitted.job_id, body, config, fetchImpl);
}

export async function submitChatJob(body, config = configFromEnv(), fetchImpl = fetch) {
  const message = String(body?.message ?? "").trim();
  if (!message) {
    throw httpError(400, "message is required");
  }
  const toolMode = isToolModeEnabled(body);
  const toolMessage = stripToolModePrefix(message);
  const compoundToolPrompt = isCompoundPromptForDirectTools(toolMessage);

  if (!compoundToolPrompt) {
    const linearEquation = extractLinearEquation(toolMessage);
    if (linearEquation) {
      return fetchLinearEquationJob(toolMessage, linearEquation);
    }

    const polynomialDerivative = extractPolynomialDerivative(toolMessage);
    if (polynomialDerivative) {
      return fetchPolynomialDerivativeJob(toolMessage, polynomialDerivative);
    }

    const polynomialIntegral = extractPolynomialIntegral(toolMessage);
    if (polynomialIntegral) {
      return fetchPolynomialIntegralJob(toolMessage, polynomialIntegral);
    }

    const weatherLocation = extractWeatherLocation(toolMessage);
    if (weatherLocation) {
      return fetchWeatherJob(toolMessage, weatherLocation, config, fetchImpl);
    }

    const identityTopic = extractAssistantIdentityTopic(toolMessage);
    if (identityTopic) {
      return fetchAssistantIdentityJob(toolMessage, identityTopic, body?.voicePersona);
    }

    const mundusxKnowledgeTopic = extractMundusXKnowledgeTopic(toolMessage);
    if (mundusxKnowledgeTopic) {
      return fetchMundusXKnowledgeJob(toolMessage, mundusxKnowledgeTopic);
    }

    const currentOfficeQuery = extractCurrentOfficeQuery(toolMessage);
    if (currentOfficeQuery) {
      const currentOfficeJob = await fetchCurrentOfficeJob(toolMessage, currentOfficeQuery, config, fetchImpl);
      if (currentOfficeJob) {
        return currentOfficeJob;
      }
    }

    const factualTopic = extractFactualSummaryTopic(toolMessage);
    if (factualTopic) {
      const factualJob = await fetchFactualSummaryJob(toolMessage, factualTopic, config, fetchImpl);
      if (factualJob) {
        return factualJob;
      }
    }
  }

  if (toolMode && needsGrounding(toolMessage)) {
    const groundingQuery = extractGeneralLookupTopic(toolMessage) || toolMessage;
    const webSearchJob = await fetchWebSearchJob(message, groundingQuery, config, fetchImpl, {
      model: body?.model,
      voicePersona: body?.voicePersona,
    });
    if (webSearchJob) {
      return webSearchJob;
    }

    const generalTopic = extractGeneralLookupTopic(toolMessage);
    if (generalTopic) {
      const generalJob = await fetchFactualSummaryJob(toolMessage, generalTopic, config, fetchImpl);
      if (generalJob) {
        return generalJob;
      }
    }
  }

  const model = String(body?.model ?? config.modelOverride ?? "").trim();
  const capacityProfile = await fetchChatCapacityProfile(config, fetchImpl, model);
  const jobBody = buildGenericJobBody(message, config, {
    model: body?.model,
    voicePersona: body?.voicePersona,
    executionMode: body?.executionMode,
    maxTokens: body?.maxTokens,
    temperature: body?.temperature,
    topP: body?.topP,
    capacityProfile,
  });

  const jobResponse = await controlPlaneFetch(
    fetchImpl,
    config,
    "/v1/jobs",
    {
      method: "POST",
      body: JSON.stringify(jobBody),
    },
  );

  const job = jobResponse.job ?? jobResponse;
  const jobId = jobResponse.job_id ?? job.job_id;
  if (!jobId) {
    throw httpError(502, "control plane did not return a job id");
  }

  return formatChatJob(jobId, job, jobBody.model || null);
}

function buildGenericJobBody(message, config, options = {}) {
  const model = String(options.model ?? config.modelOverride ?? "").trim();
  const jobBody = {
    request_id: `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    prompt: message,
    preferred_backend: "auto",
    runtime_mode: "local",
    execution_mode: normalizeExecutionMode(options.executionMode ?? "auto"),
    stream: false,
    system_prompt: options.systemPrompt ?? buildChatSystemPrompt(message, options.voicePersona),
    max_tokens: inferMaxTokens(message, options.maxTokens, options.capacityProfile ?? null),
    temperature: typeof options.temperature === "number" ? options.temperature : 0.2,
    top_p: typeof options.topP === "number" ? options.topP : 0.9,
  };
  if (model) {
    jobBody.model = model;
  }
  return jobBody;
}

async function fetchChatCapacityProfile(config, fetchImpl, requestedModel = "") {
  try {
    const payload = await controlPlaneFetch(fetchImpl, config, "/v1/nodes?page=1&page_size=25");
    const nodes = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
    return strongestCapacityProfile(nodes, requestedModel);
  } catch {
    return requestedModel ? capacityProfileFromModel(requestedModel, null) : null;
  }
}

function strongestCapacityProfile(nodes, requestedModel = "") {
  const profiles = nodes
    .map((node) => capacityProfileFromNode(node, requestedModel))
    .filter(Boolean);
  if (!profiles.length) {
    return requestedModel ? capacityProfileFromModel(requestedModel, null) : null;
  }
  return profiles.sort((left, right) => right.score - left.score)[0];
}

function capacityProfileFromNode(node, requestedModel = "") {
  if (!node || node.policy_allowed === false || node.computed_policy_allowed === false || node.on_battery === true) {
    return null;
  }
  const state = String(node.state ?? node.reported_state ?? "").toLowerCase();
  const reportedState = String(node.reported_state ?? node.state ?? "").toLowerCase();
  if (!["ready", "online", "idle"].includes(state) && !["ready", "online", "idle"].includes(reportedState)) {
    return null;
  }
  const health = node.worker_health ?? {};
  if (health.healthy === false || health.runtime_ready === false) {
    return null;
  }
  const modelName = requestedModel || health.model_name || node.model || "";
  const gpuAvailable = positiveInteger(node.available_gpu_percent, 0);
  const memoryMb = positiveInteger(node.available_memory_mb, 0);
  const cudaReady = health.cuda_device_available === true || String(node.backend ?? "").toLowerCase() === "cuda";
  const lowVram = String(health.notes ?? "").toLowerCase().includes("low-vram");
  const base = capacityProfileFromModel(modelName, { gpuAvailable, memoryMb, cudaReady, lowVram });
  return {
    ...base,
    score: base.score + Math.min(20, Math.floor(gpuAvailable / 5)) + Math.min(20, Math.floor(memoryMb / 2048)),
  };
}

function capacityProfileFromModel(modelName, node = null) {
  const modelBillions = modelSizeBillions(modelName);
  const gpuAvailable = node?.gpuAvailable ?? 0;
  const memoryMb = node?.memoryMb ?? 0;
  const cudaReady = node?.cudaReady ?? false;
  const lowVram = node?.lowVram ?? false;
  let tier = "small";
  let score = modelBillions * 10;

  if (!lowVram && cudaReady && modelBillions >= 14 && memoryMb >= 16000 && gpuAvailable >= 40) {
    tier = "xlarge";
    score += 80;
  } else if (!lowVram && cudaReady && modelBillions >= 7 && memoryMb >= 8000 && gpuAvailable >= 35) {
    tier = "large";
    score += 60;
  } else if (!lowVram && cudaReady && modelBillions >= 3 && memoryMb >= 6000 && gpuAvailable >= 30) {
    tier = "medium";
    score += 35;
  } else if (!lowVram && modelBillions >= 7 && memoryMb >= 8000) {
    tier = "medium";
    score += 25;
  }

  return { tier, modelBillions, gpuAvailable, memoryMb, cudaReady, lowVram, score };
}

function modelSizeBillions(modelName) {
  const lower = String(modelName ?? "").toLowerCase();
  const matches = [...lower.matchAll(/(\d+(?:[._]\d+)?)\s*b\b/g)];
  if (!matches.length) {
    return 0;
  }
  return Math.max(...matches.map((match) => Number(match[1].replace("_", "."))).filter(Number.isFinite));
}

function isToolModeEnabled(body) {
  const value = body?.toolMode ?? body?.webSearch ?? body?.tool_mode;
  if (typeof value === "boolean") {
    return value;
  }
  return /^(1|true|yes|on|tools?|web)$/i.test(String(value ?? "").trim());
}

function stripToolModePrefix(message) {
  return String(message ?? "")
    .replace(/^\s*@(?:web(?:\s+search)?|search|tools?)?\s*/i, "")
    .trim();
}

export function extractLinearEquation(message) {
  const text = String(message ?? "").trim();
  if (!/\b(?:solve|equation|find)\b/i.test(text) || !text.includes("=")) {
    return null;
  }

  const equation = cleanEquationText(text);
  const sides = equation.split("=");
  if (sides.length !== 2) {
    return null;
  }

  const left = parseLinearExpression(sides[0]);
  const right = parseLinearExpression(sides[1]);
  const variable = mergeLinearVariable(left?.variable, right?.variable);
  if (!left || !right || variable === false) {
    return null;
  }

  const coefficient = left.coefficient - right.coefficient;
  const constant = right.constant - left.constant;
  if (Math.abs(coefficient) < 1e-12) {
    return null;
  }

  const solution = normalizeNumber(constant / coefficient);
  return {
    variable,
    equation,
    solution,
    left,
    right,
  };
}

function cleanEquationText(text) {
  const normalized = String(text)
    .replace(/[，]/g, ",")
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, "");
  const match = normalized.match(/[0-9a-zA-Z+\-*/().^]+=[0-9a-zA-Z+\-*/().^]+/);
  return match ? match[0] : normalized;
}

function parseLinearExpression(expression) {
  const tokens = tokenizeLinearExpression(expression);
  if (!tokens.length) {
    return null;
  }
  const parser = createLinearParser(tokens);
  const parsed = parser.parseExpression();
  if (!parsed || parser.index !== tokens.length) {
    return null;
  }
  return parsed;
}

function tokenizeLinearExpression(expression) {
  const compact = String(expression ?? "").replace(/\s+/g, "");
  const tokens = [];
  let index = 0;
  while (index < compact.length) {
    const char = compact[index];
    if (/[0-9.]/.test(char)) {
      const match = compact.slice(index).match(/^\d+(?:\.\d+)?/);
      if (!match) return [];
      pushLinearToken(tokens, { type: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(char)) {
      pushLinearToken(tokens, { type: "variable", value: char.toLowerCase() });
      index += 1;
      continue;
    }
    if ("+-*/()".includes(char)) {
      pushLinearToken(tokens, { type: "operator", value: char });
      index += 1;
      continue;
    }
    return [];
  }
  return tokens;
}

function pushLinearToken(tokens, token) {
  const previous = tokens[tokens.length - 1];
  if (
    previous &&
    token.value !== ")" &&
    token.value !== "*" &&
    token.value !== "/" &&
    token.value !== "+" &&
    token.value !== "-" &&
    (previous.type === "number" || previous.type === "variable" || previous.value === ")") &&
    (token.type === "variable" || token.value === "(")
  ) {
    tokens.push({ type: "operator", value: "*" });
  }
  tokens.push(token);
}

function createLinearParser(tokens) {
  return {
    tokens,
    index: 0,
    peek() {
      return this.tokens[this.index];
    },
    take(value) {
      if (this.peek()?.value === value) {
        this.index += 1;
        return true;
      }
      return false;
    },
    parseExpression() {
      let value = this.parseTerm();
      if (!value) return null;
      while (this.peek()?.value === "+" || this.peek()?.value === "-") {
        const operator = this.peek().value;
        this.index += 1;
        const right = this.parseTerm();
        if (!right) return null;
        value = addLinear(value, operator === "-" ? scaleLinear(right, -1) : right);
        if (!value) return null;
      }
      return value;
    },
    parseTerm() {
      let value = this.parseFactor();
      if (!value) return null;
      while (this.peek()?.value === "*" || this.peek()?.value === "/") {
        const operator = this.peek().value;
        this.index += 1;
        const right = this.parseFactor();
        if (!right) return null;
        value = operator === "*" ? multiplyLinear(value, right) : divideLinear(value, right);
        if (!value) return null;
      }
      return value;
    },
    parseFactor() {
      if (this.take("+")) return this.parseFactor();
      if (this.take("-")) {
        const factor = this.parseFactor();
        return factor ? scaleLinear(factor, -1) : null;
      }
      const token = this.peek();
      if (!token) return null;
      if (token.type === "number") {
        this.index += 1;
        return { coefficient: 0, constant: token.value, variable: null };
      }
      if (token.type === "variable") {
        this.index += 1;
        return { coefficient: 1, constant: 0, variable: token.value };
      }
      if (this.take("(")) {
        const expression = this.parseExpression();
        if (!expression || !this.take(")")) return null;
        return expression;
      }
      return null;
    },
  };
}

function addLinear(left, right) {
  const variable = mergeLinearVariable(left.variable, right.variable);
  if (variable === false) return null;
  return {
    coefficient: left.coefficient + right.coefficient,
    constant: left.constant + right.constant,
    variable,
  };
}

function scaleLinear(value, factor) {
  return {
    coefficient: value.coefficient * factor,
    constant: value.constant * factor,
    variable: value.variable,
  };
}

function multiplyLinear(left, right) {
  if (left.variable && right.variable) {
    return null;
  }
  if (left.variable) return scaleLinear(left, right.constant);
  if (right.variable) return scaleLinear(right, left.constant);
  return { coefficient: 0, constant: left.constant * right.constant, variable: null };
}

function divideLinear(left, right) {
  if (right.variable || Math.abs(right.constant) < 1e-12) {
    return null;
  }
  return scaleLinear(left, 1 / right.constant);
}

function mergeLinearVariable(left, right) {
  if (left && right && left !== right) return false;
  return left || right || null;
}

export function extractPolynomialIntegral(message) {
  const text = String(message ?? "").trim();
  if (!/\b(?:integral|integrate|int)\b/i.test(text) || !/\bdx\b/i.test(text)) {
    return null;
  }

  const expression =
    text.match(/\bint\b\s*\(?\s*([^)]+?)\s*\)?\s*dx\b/i)?.[1] ??
    text.match(/\bintegral\s+(?:of\s+)?\(?\s*([^)]+?)\s*\)?\s*dx\b/i)?.[1] ??
    text.match(/\bintegrate\s+\(?\s*([^)]+?)\s*\)?\s*(?:with\s+respect\s+to\s+x|dx)\b/i)?.[1];
  if (!expression || !/[xX]/.test(expression)) {
    return null;
  }

  const terms = parsePolynomialTerms(expression);
  if (!terms.length) {
    return null;
  }
  return {
    variable: "x",
    expression: formatPolynomial(terms),
    result: formatPolynomial(terms.map((term) => ({
      coefficient: term.coefficient / (term.power + 1),
      power: term.power + 1,
    })), " + C"),
    terms,
  };
}

export function extractPolynomialDerivative(message) {
  const text = String(message ?? "").trim();
  if (!/\b(?:derivative|differentiate|d\/dx)\b/i.test(text)) {
    return null;
  }

  const normalizedText = text.replace(/\s+/g, " ");
  const expression =
    normalizedText.match(/\bf\s*\(\s*x\s*\)\s*=\s*(.+?)(?=\s+\bis\b|\?|$)/i)?.[1] ??
    normalizedText.match(/\b(?:derivative|differentiate)\s+(?:of\s+)?\(?\s*(.+?)\s*\)?(?:\s+with\s+respect\s+to\s+x|\?|$)/i)?.[1] ??
    normalizedText.match(/\bd\/dx\s*\(?\s*(.+?)\s*\)?(?:\?|$)/i)?.[1];
  if (!expression || !/[xX]/.test(expression)) {
    return null;
  }

  const terms = parsePolynomialTerms(expression);
  if (!terms.length) {
    return null;
  }

  const derivativeTerms = combinePolynomialTerms(terms
    .filter((term) => term.power > 0)
    .map((term) => ({
      coefficient: term.coefficient * term.power,
      power: term.power - 1,
    })));
  const result = derivativeTerms.length ? formatPolynomial(derivativeTerms) : "0";
  const proposedExpression =
    normalizedText.match(/\bis\s+(?:f\s*'?\s*\(\s*x\s*\)\s*=\s*)?(.+?)(?:\s+is\s+this\s+true|\s+true|\?|$)/i)?.[1] ?? null;
  const proposedTerms = proposedExpression && /[xX0-9]/.test(proposedExpression)
    ? parsePolynomialTerms(proposedExpression)
    : [];
  const proposed = proposedTerms.length ? formatPolynomial(proposedTerms) : null;
  const isCorrect = proposed ? polynomialsEqual(derivativeTerms, proposedTerms) : null;

  return {
    variable: "x",
    expression: formatPolynomial(terms),
    result,
    terms,
    proposed,
    isCorrect,
  };
}

function parsePolynomialTerms(expression) {
  const normalized = String(expression)
    .replace(/\s+/g, "")
    .replace(/\*/g, "")
    .replace(/−/g, "-");
  if (!normalized || /[^0-9xX^+\-.]/.test(normalized)) {
    return [];
  }

  const pieces = normalized.match(/[+-]?[^+-]+/g) ?? [];
  const terms = [];
  for (const piece of pieces) {
    const term = parsePolynomialTerm(piece);
    if (!term) {
      return [];
    }
    terms.push(term);
  }
  return combinePolynomialTerms(terms);
}

function polynomialsEqual(leftTerms, rightTerms) {
  const left = combinePolynomialTerms(leftTerms);
  const right = combinePolynomialTerms(rightTerms);
  if (left.length !== right.length) {
    return false;
  }
  return left.every((term, index) => (
    term.power === right[index].power &&
    Math.abs(term.coefficient - right[index].coefficient) < 1e-12
  ));
}

function parsePolynomialTerm(piece) {
  const value = String(piece ?? "");
  if (!value) {
    return null;
  }
  const sign = value.startsWith("-") ? -1 : 1;
  const unsigned = value.replace(/^[+-]/, "");
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(unsigned)) {
    return { coefficient: sign * Number(unsigned), power: 0 };
  }

  const match = unsigned.match(/^([0-9]+(?:\.[0-9]+)?)?[xX](?:\^([0-9]+))?$/);
  if (!match) {
    return null;
  }
  return {
    coefficient: sign * Number(match[1] ?? 1),
    power: Number(match[2] ?? 1),
  };
}

function combinePolynomialTerms(terms) {
  const byPower = new Map();
  for (const term of terms) {
    byPower.set(term.power, (byPower.get(term.power) ?? 0) + term.coefficient);
  }
  return [...byPower.entries()]
    .map(([power, coefficient]) => ({ power, coefficient }))
    .filter((term) => Math.abs(term.coefficient) > 1e-12)
    .sort((a, b) => b.power - a.power);
}

function formatPolynomial(terms, suffix = "") {
  const parts = [];
  for (const term of terms) {
    const formatted = formatPolynomialTerm(term);
    if (!formatted) {
      continue;
    }
    if (!parts.length) {
      parts.push(formatted);
    } else if (formatted.startsWith("-")) {
      parts.push(`- ${formatted.slice(1)}`);
    } else {
      parts.push(`+ ${formatted}`);
    }
  }
  return `${parts.join(" ")}${suffix}`;
}

function formatPolynomialTerm(term) {
  const coefficient = normalizeNumber(term.coefficient);
  if (coefficient === 0) {
    return "";
  }
  const sign = coefficient < 0 ? "-" : "";
  const abs = Math.abs(coefficient);
  if (term.power === 0) {
    return `${sign}${formatNumber(abs)}`;
  }
  const coefficientText = abs === 1 ? "" : formatNumber(abs);
  const variable = term.power === 1 ? "x" : `x^${term.power}`;
  return `${sign}${coefficientText}${variable}`;
}

function normalizeNumber(value) {
  const rounded = Math.round(value * 1e12) / 1e12;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatNumber(value) {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Number(value.toFixed(6))).replace(/\.0+$/, "");
}

function fetchPolynomialIntegralJob(message, integral) {
  const answer = integral.result;
  const output = [
    `Integral: ${integral.expression}`,
    `Answer: ${answer}`,
    "Rule used: integrate each term a*x^n as (a/(n+1))*x^(n+1), then add C.",
  ].join("\n\n");

  return {
    job_id: `math-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
    status: "completed",
    output,
    output_cleaned: false,
    error: null,
    model: "math-tool",
    assigned_node_id: "math-tool",
    execution_mode: "tool",
    graph_execution_enabled: false,
    tool: "polynomial_integral",
    response: {
      type: "math_solution",
      title: "Polynomial integral",
      answer,
      steps: [
        `Start with ${integral.expression}.`,
        "Integrate each term using a*x^n -> (a/(n+1))*x^(n+1).",
        `Add the constant of integration: ${answer}.`,
      ],
    },
    progress: {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: "math_tool",
    },
  };
}

function fetchPolynomialDerivativeJob(message, derivative) {
  const answer = derivative.isCorrect === null
    ? `f'(x) = ${derivative.result}`
    : derivative.isCorrect
      ? `Yes. f'(x) = ${derivative.result}.`
      : `No. The correct derivative is f'(x) = ${derivative.result}.`;
  const compareLine = derivative.proposed
    ? `Proposed derivative: ${derivative.proposed}`
    : null;
  const output = [
    `Function: f(x) = ${derivative.expression}`,
    compareLine,
    `Answer: ${answer}`,
    "Rule used: differentiate each term a*x^n as a*n*x^(n-1); constants become 0.",
  ].filter(Boolean).join("\n\n");

  return {
    job_id: `math-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
    status: "completed",
    output,
    output_cleaned: false,
    error: null,
    model: "math-tool",
    assigned_node_id: "math-tool",
    execution_mode: "tool",
    graph_execution_enabled: false,
    tool: "polynomial_derivative",
    response: {
      type: "math_solution",
      title: "Polynomial derivative",
      answer,
      steps: [
        `Start with f(x) = ${derivative.expression}.`,
        "Differentiate each term using d/dx(a*x^n) = a*n*x^(n-1).",
        `So f'(x) = ${derivative.result}.`,
      ],
    },
    progress: {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: "polynomial_derivative_tool",
    },
  };
}

async function fetchWeatherJob(message, location, config, fetchImpl) {
  const cacheKey = weatherCacheKey(location);
  let cacheHit = false;
  let weather = null;

  if (config.weatherCacheUrl) {
    const cached = await redisGet(config.weatherCacheUrl, cacheKey);
    if (cached) {
      try {
        weather = JSON.parse(cached);
        cacheHit = true;
      } catch {
        weather = null;
      }
    }
  }

  if (!weather) {
    weather = await fetchWeatherSummary(location, config, fetchImpl);
    if (config.weatherCacheUrl) {
      await redisSet(config.weatherCacheUrl, cacheKey, JSON.stringify(weather), config.weatherTtlSeconds);
    }
  }

  const output = weather.output;
  return {
    job_id: `weather-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
    status: "completed",
    output,
    output_cleaned: false,
    error: null,
    model: "wttr.in",
    assigned_node_id: "weather-tool",
    execution_mode: "tool",
    graph_execution_enabled: false,
    tool: "weather",
    cache_hit: cacheHit,
    response: weather.response,
    progress: {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: "weather_tool",
    },
  };
}

function fetchLinearEquationJob(message, equation) {
  const answer = `${equation.variable} = ${formatNumber(equation.solution)}`;
  const reducedCoefficient = normalizeNumber(equation.left.coefficient - equation.right.coefficient);
  const reducedConstant = normalizeNumber(equation.right.constant - equation.left.constant);
  const output = [
    `Equation: ${equation.equation}`,
    `Answer: ${answer}`,
    "",
    "Method:",
    `Move variable terms and constants to opposite sides: ${formatNumber(reducedCoefficient)}${equation.variable} = ${formatNumber(reducedConstant)}`,
    `Divide both sides by ${formatNumber(reducedCoefficient)}.`,
  ].join("\n");
  return {
    job_id: `math-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
    status: "completed",
    output,
    output_cleaned: false,
    error: null,
    model: "math-tool",
    assigned_node_id: "math-tool",
    execution_mode: "tool",
    graph_execution_enabled: false,
    tool: "linear_equation",
    response: {
      type: "math_solution",
      title: "Linear equation",
      answer,
      steps: [
        equation.equation,
        `${formatNumber(reducedCoefficient)}${equation.variable} = ${formatNumber(reducedConstant)}`,
        answer,
      ],
    },
    progress: {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: "linear_equation_tool",
    },
  };
}

function extractAssistantIdentityTopic(message) {
  const lower = String(message ?? "").toLowerCase().trim();
  if (!lower) {
    return null;
  }
  if (
    /\b(?:introduce yourself|tell me about yourself|who are you|what are you|do you have a name|what(?:'s| is) your name)\b/i.test(lower)
  ) {
    return "identity";
  }
  if (/\b(?:your mission|your vision|mission and vision|what(?:'s| is) your purpose)\b/i.test(lower)) {
    return "mission";
  }
  return null;
}

function fetchAssistantIdentityJob(message, topic, voicePersona = "atlas") {
  const persona = resolveVoicePersona(voicePersona);
  const personaName = persona === "marie" ? "Marie" : "Atlas";
  const output = topic === "mission"
    ? [
        `I'm ${personaName}, the MundusX assistant.`,
        "My mission is to help people understand, build with, and participate in MundusX: a community-powered decentralized AI compute network.",
        "My vision is simple: make useful AI more accessible, affordable, and collaborative by connecting contributor machines into a shared compute ecosystem.",
      ].join("\n")
    : [
        `I'm ${personaName}, the MundusX assistant.`,
        "I help answer questions, explain MundusX, troubleshoot nodes and jobs, and support developers and contributors using the network.",
        "MundusX is focused on community-powered decentralized AI compute, where available machines can help serve AI workloads.",
      ].join("\n");

  return {
    job_id: `identity-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
    status: "completed",
    output,
    output_cleaned: false,
    error: null,
    model: "mundusx-identity",
    assigned_node_id: "persona-tool",
    execution_mode: "tool",
    graph_execution_enabled: false,
    tool: "assistant_identity",
    response: {
      type: "assistant_identity",
      topic,
      persona: personaName,
    },
    progress: {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: "assistant_identity_tool",
    },
  };
}

function extractMundusXKnowledgeTopic(message) {
  const lower = String(message ?? "").toLowerCase();
  if (!/\bmundusx\b/.test(lower)) {
    return null;
  }
  if (containsAny(lower, ["blockchain", "consensus", "smart contract", "ethereum"])) {
    return null;
  }
  if (
    containsAny(lower, [
      "benefit",
      "advantage",
      "why use",
      "why should",
      "important",
      "importance",
      "value",
      "mission",
      "vision",
      "what is",
      "explain",
    ])
  ) {
    return "overview";
  }
  return null;
}

function fetchMundusXKnowledgeJob(message, topic) {
  const output = [
    "The most important benefits of the MundusX decentralized AI compute network are:",
    "",
    "1. Accessibility: MundusX is designed to make AI compute reachable through community-contributed machines instead of only large centralized data centers.",
    "",
    "2. Lower cost potential: By routing work to available contributor GPUs and CPUs, MundusX can reduce dependence on expensive centralized inference providers.",
    "",
    "3. Contributor participation: People who share idle compute can help power AI workloads and earn recognition or rewards through the network model.",
    "",
    "4. Flexible compute supply: The network can grow across Windows, macOS, Linux, GPUs, CPUs, edge devices, and servers as contributors join.",
    "",
    "5. Open collaboration: MundusX is built around an open-source, community-powered direction so developers and operators can inspect, improve, and extend the system.",
    "",
    "6. Resilience through distribution: Workloads can be routed across multiple available nodes instead of depending on one machine or one provider.",
    "",
    "7. Practical routing: The control plane can match jobs to nodes by model, backend, health, policy, trust, and available capacity.",
    "",
    "MundusX is not currently described as a blockchain consensus network in this product path. Its core idea is decentralized AI compute: contributors provide usable compute, and the control plane routes AI work to suitable nodes.",
  ].join("\n");

  return {
    job_id: `mundusx-facts-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
    status: "completed",
    output,
    output_cleaned: false,
    error: null,
    model: "mundusx-knowledge",
    assigned_node_id: "facts-tool",
    execution_mode: "tool",
    graph_execution_enabled: false,
    tool: "mundusx_knowledge",
    response: {
      type: "mundusx_knowledge",
      topic,
    },
    progress: {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: "mundusx_knowledge_tool",
    },
  };
}

export function extractWeatherLocation(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (!/\b(weather|forecast|temperature|temp)\b/.test(lower)) {
    return null;
  }
  if (hasNonWeatherCompoundIntent(lower)) {
    return null;
  }

  const patterns = [
    /\b(?:weather|forecast|temperature|temp)\s+(?:in|for|at|of)\s+(.+)$/i,
    /\b(?:what(?:'s| is)?|how(?:'s| is)?)\s+(?:the\s+)?(?:weather|forecast|temperature|temp)(?:\s+like)?\s+(?:in|for|at|of)\s+(.+)$/i,
    /\b(?:weather|forecast|temperature|temp)\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const location = cleanWeatherLocation(match?.[1]);
    if (location) {
      return location;
    }
  }
  return null;
}

function isCompoundPromptForDirectTools(message) {
  const lower = String(message ?? "").toLowerCase();
  if (!lower) {
    return false;
  }
  const hasConnector = /\b(?:and|also|then|after that|next)\b|[.;]/i.test(lower);
  if (!hasConnector) {
    return false;
  }
  const intentChecks = [
    /\b(?:weather|forecast|temperature|temp)\b/i,
    /\b(?:introduce yourself|who are you|what'?s your name|do you have a name|your mission|your vision)\b/i,
    /\b(?:who is|who's|tell me who|tell me about)\b/i,
    /\b(?:history of|translate|write|create|code|program|explain|summarize)\b/i,
    /\b(?:solve|derivative|integral|differentiate|compute|calculate)\b/i,
  ];
  return intentChecks.reduce((count, pattern) => count + (pattern.test(lower) ? 1 : 0), 0) > 1;
}

function hasNonWeatherCompoundIntent(lowerText) {
  const hasConnector = /\b(?:and|also|then|after that|next)\b|[.;]/i.test(lowerText);
  if (!hasConnector) {
    return false;
  }
  const nonWeatherIntent =
    /\b(?:introduce yourself|who are you|what'?s your name|do you have a name|your mission|your vision)\b/i.test(
      lowerText,
    ) ||
    /\b(?:who is|who's|tell me who|tell me about|history of|translate|write|create|code|program|explain|summarize)\b/i.test(
      lowerText,
    );
  return nonWeatherIntent;
}

function cleanWeatherLocation(value) {
  let location = String(value ?? "")
    .replace(/[?!.,]+$/g, "")
    .replace(/\b(?:today|now|right now|currently|please|pls)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  location = location.replace(/^(?:the\s+)?weather\s+(?:in|for|at|of)\s+/i, "").trim();
  location = location
    .replace(/\s+\b(?:and|with)\s+(?:humidity|wind|forecast|temperature|temp|conditions|rain|snow|uv|air quality)\b.*$/i, "")
    .trim();
  if (!location || location.length < 2 || location.length > 120) {
    return null;
  }
  return location;
}

async function fetchWeatherSummary(location, config, fetchImpl) {
  const url = `${config.weatherBaseUrl}/${encodeURIComponent(location)}?format=j1`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "MundusX-Chat/0.1 weather-router" },
  });
  if (!response.ok) {
    throw httpError(502, `weather lookup failed for ${location}`);
  }
  const payload = await response.json();
  return formatWeatherSummary(location, payload);
}

function formatWeatherSummary(requestedLocation, payload) {
  const current = payload?.current_condition?.[0];
  if (!current) {
    throw httpError(502, `weather lookup returned no current conditions for ${requestedLocation}`);
  }
  const area = payload?.nearest_area?.[0];
  const areaName = area?.areaName?.[0]?.value ?? requestedLocation;
  const region = area?.region?.[0]?.value ?? "";
  const country = area?.country?.[0]?.value ?? "";
  const place = [areaName, region, country].filter(Boolean).join(", ");
  const condition = current.weatherDesc?.[0]?.value ?? "current conditions";
  const tempC = current.temp_C;
  const tempF = current.temp_F;
  const feelsC = current.FeelsLikeC;
  const feelsF = current.FeelsLikeF;
  const humidity = current.humidity;
  const windKmph = current.windspeedKmph;
  const observation = current.localObsDateTime ? ` Observed ${current.localObsDateTime}.` : "";
  const summary = `${condition}, ${tempC}C/${tempF}F`;
  return {
    output: `Weather for ${place}: ${summary}, feels like ${feelsC}C/${feelsF}F, humidity ${humidity}%, wind ${windKmph} km/h.${observation}`,
    response: {
      type: "weather_result",
      title: `Weather for ${place}`,
      summary,
      facts: {
        "Feels like": `${feelsC}C/${feelsF}F`,
        Humidity: `${humidity}%`,
        Wind: `${windKmph} km/h`,
        Observed: current.localObsDateTime ?? null,
      },
    },
  };
}

export function extractCurrentOfficeQuery(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (!/\b(?:current|now|today|202\d|latest)\b/.test(lower)) {
    return null;
  }
  const match = lower.match(/\b(?:who\s+is\s+)?(?:the\s+)?current\s+president\s+of\s+(.+?)(?:\s+(?:today|now|currently|in\s+202\d|year\s+202\d))*[?.!]*$/i);
  if (!match) {
    return null;
  }
  const country = cleanCountryName(match[1]);
  const countryInfo = country ? countryEntityFor(country) : null;
  if (!countryInfo) {
    return null;
  }
  return {
    office: "president",
    relationProperty: "P6",
    country: countryInfo.name,
    countryEntityId: countryInfo.entityId,
  };
}

function cleanCountryName(value) {
  return String(value ?? "")
    .replace(/\b(?:today|now|currently|please|pls|year|in)\b/gi, "")
    .replace(/\b202\d\b/g, "")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countryEntityFor(country) {
  const key = String(country ?? "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const countries = new Map([
    ["usa", { name: "the United States", entityId: "Q30" }],
    ["us", { name: "the United States", entityId: "Q30" }],
    ["u s", { name: "the United States", entityId: "Q30" }],
    ["america", { name: "the United States", entityId: "Q30" }],
    ["united states", { name: "the United States", entityId: "Q30" }],
    ["united states of america", { name: "the United States", entityId: "Q30" }],
    ["philippines", { name: "the Philippines", entityId: "Q928" }],
    ["ph", { name: "the Philippines", entityId: "Q928" }],
  ]);
  return countries.get(key) ?? null;
}

async function fetchCurrentOfficeJob(message, query, config, fetchImpl) {
  try {
    const output = await fetchCurrentOfficeAnswer(query, config, fetchImpl);
    return {
      job_id: `facts-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
      status: "completed",
      output,
      output_cleaned: false,
      error: null,
      model: "wikidata",
      assigned_node_id: "facts-tool",
      execution_mode: "tool",
      graph_execution_enabled: false,
      tool: "current_office_holder",
      progress: {
        total: 0,
        completed: 0,
        running: 0,
        failed: 0,
        waiting: 0,
        processing: null,
        merging: false,
        strategy: "current_office_tool",
      },
    };
  } catch {
    return null;
  }
}

async function fetchCurrentOfficeAnswer(query, config, fetchImpl) {
  const country = await fetchWikidataEntity(query.countryEntityId, config, fetchImpl);
  const holderId = extractEntityClaimId(country, query.relationProperty);
  if (!holderId) {
    throw httpError(502, `current ${query.office} lookup returned no holder for ${query.country}`);
  }
  const holder = await fetchWikidataEntity(holderId, config, fetchImpl);
  const holderName = entityEnglishLabel(holder, holderId);
  return `Current ${query.office} of ${query.country}: ${holderName}. Source: Wikidata ${query.countryEntityId} ${query.relationProperty}.`;
}

async function fetchWikidataEntity(entityId, config, fetchImpl) {
  const url = `${config.wikidataEntityBaseUrl}/${encodeURIComponent(entityId)}.json`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "MundusX-Chat/0.1 factual-router" },
  });
  if (!response.ok) {
    throw httpError(502, `wikidata lookup failed for ${entityId}`);
  }
  const payload = await response.json();
  const entity = payload?.entities?.[entityId];
  if (!entity) {
    throw httpError(502, `wikidata lookup returned no entity for ${entityId}`);
  }
  return entity;
}

function extractEntityClaimId(entity, propertyId) {
  const claims = entity?.claims?.[propertyId] ?? [];
  const ranked = claims.find((claim) => claim.rank === "preferred") ?? claims.find((claim) => claim.rank !== "deprecated");
  const value = ranked?.mainsnak?.datavalue?.value;
  return typeof value?.id === "string" ? value.id : null;
}

function entityEnglishLabel(entity, fallback) {
  const labels = entity?.labels ?? {};
  return labels.en?.value ?? labels.mul?.value ?? labels["en-us"]?.value ?? labels["en-gb"]?.value ?? fallback;
}

export function extractFactualSummaryTopic(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (!/\b(history|who is|what is|tell me about|overview of|background of)\b/.test(lower)) {
    return null;
  }
  if (/\b(write|draft|create|generate|code|program|email|poem|story|summarize this|explain why)\b/.test(lower)) {
    return null;
  }

  const patterns = [
    /\b(?:give me|tell me|show me)?\s*(?:a\s+)?(?:brief\s+|detailed\s+)?history\s+of\s+(.+?)(?:\s+from\s+.+)?[?.!]*$/i,
    /\b(?:who|what)\s+is\s+(.+?)[?.!]*$/i,
    /\b(?:tell me about|overview of|background of)\s+(.+?)[?.!]*$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const topic = cleanFactualTopic(match?.[1]);
    if (topic) {
      return topic;
    }
  }
  return null;
}

function cleanFactualTopic(value) {
  const topic = String(value ?? "")
    .replace(/\b(?:today|now|please|pls|in detail|from its origins to today|from origins to today)\b/gi, "")
    .replace(/\s+from\s+(?:the\s+)?.+$/i, "")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!topic || topic.length < 2 || topic.length > 100) {
    return null;
  }
  return topic;
}

const GENERIC_LOOKUP_LEAD_IN =
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:provide(?:\s+me)?|give\s+me|share(?:\s+with\s+me)?|find\s+me|look\s+up|search(?:\s+for)?|tell\s+me|show\s+me)\b/i;
const GENERIC_LOOKUP_FILLER =
  /\b(?:more\s+)?(?:truthful|accurate|reliable|verified|factual|real|actual|updated|latest)?\s*(?:information|info|details?|facts?|data)\s+(?:about|on|regarding)\b/i;
const GENERIC_LOOKUP_TRAILER =
  /\s*(?:with\s+)?(?:reference|references|sources?|citations?)\s+(?:in|from|on)\s+the\s+internet\b.*$/i;

export function extractGeneralLookupTopic(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (/\b(write|draft|create|generate|code|program|email|poem|story|summarize this|explain why)\b/.test(lower)) {
    return null;
  }

  let candidate = text.replace(GENERIC_LOOKUP_LEAD_IN, "").trim();
  if (candidate === text) {
    return null;
  }
  candidate = candidate.replace(GENERIC_LOOKUP_FILLER, "").trim();
  candidate = candidate.replace(GENERIC_LOOKUP_TRAILER, "").trim();
  candidate = candidate.replace(/^(?:about|on|regarding)\s+/i, "").trim();

  return cleanFactualTopic(candidate);
}

const GROUNDING_NEGATIVE_PATTERN =
  /\b(write|draft|create|generate|code|program|email|poem|story|summarize this|explain why|translate|rewrite|refactor|pretend|roleplay|joke|brainstorm)\b/i;
const GROUNDING_CONVERSATIONAL_PATTERN =
  /^(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|good morning|good night|how are you|what's up|sup)\b/i;
const GROUNDING_OPINION_PATTERN = /\b(do you think|your opinion|should i|would you|what do you feel)\b/i;
const GROUNDING_FACTUAL_MARKERS = [
  "when did",
  "when was",
  "when will",
  "how many",
  "how much",
  "how old",
  "what year",
  "what date",
  "latest",
  "current",
  "currently",
  "recent",
  "as of",
  "price of",
  "cost of",
  "score of",
  "result of",
  "population of",
  "capital of",
  "founder of",
  "ceo of",
  "release date",
  "net worth",
  "who won",
  "who is",
  "what is",
  "where is",
  "which country",
  "which company",
];

export function needsGrounding(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();

  if (GROUNDING_NEGATIVE_PATTERN.test(lower)) {
    return false;
  }
  if (GROUNDING_CONVERSATIONAL_PATTERN.test(lower)) {
    return false;
  }
  if (GROUNDING_OPINION_PATTERN.test(lower)) {
    return false;
  }
  if (text.length < 12 && !text.includes("?")) {
    return false;
  }

  let score = 0;
  if (containsAny(lower, GROUNDING_FACTUAL_MARKERS)) {
    score += 2;
  }
  if (/\b(19|20)\d{2}\b/.test(lower)) {
    score += 1;
  }
  if (/\?\s*$/.test(text)) {
    score += 1;
  }
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(text)) {
    score += 1;
  }

  return score >= 2;
}

async function fetchFactualSummaryJob(message, topic, config, fetchImpl) {
  try {
    const output = await fetchFactualSummary(topic, config, fetchImpl);
    return {
      job_id: `facts-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
      status: "completed",
      output,
      output_cleaned: false,
      error: null,
      model: "wikipedia-summary",
      assigned_node_id: "facts-tool",
      execution_mode: "tool",
      graph_execution_enabled: false,
      tool: "factual_summary",
      progress: {
        total: 0,
        completed: 0,
        running: 0,
        failed: 0,
        waiting: 0,
        processing: null,
        merging: false,
        strategy: "factual_summary_tool",
      },
    };
  } catch {
    return null;
  }
}

async function fetchFactualSummary(topic, config, fetchImpl) {
  const resolvedTitle = await resolveWikipediaTitle(topic, config, fetchImpl);
  const lookupTitle = resolvedTitle ?? topic;
  const url = `${config.factualSummaryBaseUrl}/${encodeURIComponent(lookupTitle)}`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "MundusX-Chat/0.1 factual-router" },
  });
  if (!response.ok) {
    throw httpError(502, `factual lookup failed for ${topic}`);
  }
  const payload = await response.json();
  const title = payload.title ?? lookupTitle;
  const extract = String(payload.extract ?? "").trim();
  if (!extract || payload.type === "disambiguation") {
    throw httpError(502, `factual lookup returned no summary for ${topic}`);
  }
  const description = payload.description ? ` ${payload.description}.` : "";
  return `${title}:${description} ${extract}`.replace(/\s+/g, " ").trim();
}

async function resolveWikipediaTitle(topic, config, fetchImpl) {
  try {
    const searchOrigin = new URL(config.factualSummaryBaseUrl).origin;
    const searchUrl = `${searchOrigin}/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=${encodeURIComponent(topic)}`;
    const response = await fetchImpl(searchUrl, {
      headers: { Accept: "application/json", "User-Agent": "MundusX-Chat/0.1 factual-router" },
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const bestMatch = Array.isArray(payload) ? payload[1]?.[0] : null;
    if (typeof bestMatch !== "string" || !bestMatch.trim()) {
      return null;
    }
    return isPlausibleTitleMatch(topic, bestMatch) ? bestMatch.trim() : null;
  } catch {
    return null;
  }
}

const TITLE_MATCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "in", "on", "at", "for", "to", "is", "was",
]);

function significantWords(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !TITLE_MATCH_STOPWORDS.has(word));
}

function isPlausibleTitleMatch(topic, resolvedTitle) {
  const topicWords = significantWords(topic);
  if (topicWords.length === 0) {
    return true;
  }
  const titleWords = new Set(significantWords(resolvedTitle));
  const overlap = topicWords.filter((word) => titleWords.has(word)).length;
  return overlap > topicWords.length / 2;
}

async function fetchWebSearchSnippets(query, config, fetchImpl) {
  const cacheKey = webSearchCacheKey(query);
  if (config.weatherCacheUrl) {
    const cached = await redisGet(config.weatherCacheUrl, cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Fall through to a live lookup if the cached payload is malformed.
      }
    }
  }

  if (config.weatherCacheUrl && config.webSearchDailyBudget > 0) {
    const overBudget = await webSearchBudgetExceeded(config);
    if (overBudget) {
      return null;
    }
  }

  if (!config.webSearchApiKey) {
    return null;
  }

  const url = new URL(config.webSearchBaseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(config.webSearchMaxResults));

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": config.webSearchApiKey,
        "User-Agent": "MundusX-Chat/0.1 web-search-router",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const results = payload?.web?.results;
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const sources = results
    .slice(0, config.webSearchMaxResults)
    .map((result) => ({
      title: String(result?.title ?? "").trim(),
      url: String(result?.url ?? "").trim(),
      snippet: String(result?.description ?? "").replace(/<\/?strong>/g, "").trim(),
    }))
    .filter((source) => source.title && source.url && source.snippet);

  if (sources.length === 0) {
    return null;
  }

  if (config.weatherCacheUrl) {
    await redisSet(config.weatherCacheUrl, cacheKey, JSON.stringify(sources), config.webSearchTtlSeconds);
    await webSearchRecordCall(config);
  }

  return sources;
}

function webSearchCacheKey(query) {
  return `mundusx:websearch:v1:${query.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function webSearchBudgetKey() {
  const day = new Date().toISOString().slice(0, 10);
  return `mundusx:websearch:budget:v1:${day}`;
}

async function webSearchBudgetExceeded(config) {
  const current = await redisGet(config.weatherCacheUrl, webSearchBudgetKey());
  const count = Number(current);
  return Number.isFinite(count) && count >= config.webSearchDailyBudget;
}

async function webSearchRecordCall(config) {
  try {
    const key = webSearchBudgetKey();
    const count = await redisCommand(config.weatherCacheUrl, ["INCR", key]);
    if (Number(count) === 1) {
      await redisCommand(config.weatherCacheUrl, ["EXPIRE", key, "172800"]);
    }
  } catch {
    // Budget tracking is best-effort; a missed increment only risks one extra call.
  }
}

async function fetchWebSearchJob(message, query, config, fetchImpl, jobOptions = {}) {
  const sources = await fetchWebSearchSnippets(query, config, fetchImpl);
  if (!sources || sources.length === 0) {
    return null;
  }

  const jobBody = buildGenericJobBody(message, config, {
    ...jobOptions,
    systemPrompt: buildGroundedSystemPrompt(message, jobOptions.voicePersona, sources),
  });

  const jobResponse = await controlPlaneFetch(fetchImpl, config, "/v1/jobs", {
    method: "POST",
    body: JSON.stringify(jobBody),
  });

  const job = jobResponse.job ?? jobResponse;
  const jobId = jobResponse.job_id ?? job.job_id;
  if (!jobId) {
    throw httpError(502, "control plane did not return a job id");
  }

  trackGroundingSources(jobId, sources, config);

  const formatted = formatChatJob(jobId, job, jobBody.model || null);
  return { ...formatted, tool: "web_search", sources };
}

function buildGroundedSystemPrompt(message, voicePersona, sources) {
  const basePrompt = buildChatSystemPrompt(message, voicePersona);
  const sourceList = sources
    .map((source, index) => `[${index + 1}] ${source.title} — ${source.snippet} (source: ${source.url})`)
    .join("\n");
  return [
    basePrompt,
    "Answer using ONLY the sources listed below. Cite the sources you use inline as [1], [2], etc., matching the numbers below.",
    "If the sources do not contain the answer, say so explicitly rather than guessing.",
    "Sources:",
    sourceList,
  ].join("\n");
}

const groundingSourcesByJobId = new Map();

function trackGroundingSources(jobId, sources, config) {
  groundingSourcesByJobId.set(jobId, sources);
  if (config.weatherCacheUrl) {
    redisSet(
      config.weatherCacheUrl,
      groundingSourcesCacheKey(jobId),
      JSON.stringify(sources),
      3600,
    ).catch(() => {});
  }
}

async function lookupGroundingSources(jobId, config) {
  if (groundingSourcesByJobId.has(jobId)) {
    return groundingSourcesByJobId.get(jobId);
  }
  if (!config.weatherCacheUrl) {
    return null;
  }
  const cached = await redisGet(config.weatherCacheUrl, groundingSourcesCacheKey(jobId));
  if (!cached) {
    return null;
  }
  try {
    return JSON.parse(cached);
  } catch {
    return null;
  }
}

function groundingSourcesCacheKey(jobId) {
  return `mundusx:websearch:sources:v1:${jobId}`;
}

function weatherCacheKey(location) {
  return `mundusx:weather:v1:${location.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

async function redisGet(redisUrl, key) {
  try {
    const result = await redisCommand(redisUrl, ["GET", key]);
    return typeof result === "string" && result.trim() ? result : null;
  } catch {
    return null;
  }
}

async function redisSet(redisUrl, key, value, ttlSeconds) {
  try {
    await redisCommand(redisUrl, ["SET", key, value, "EX", String(ttlSeconds)]);
  } catch {
    // Weather cache is optional; direct wttr.in lookup remains the source of truth.
  }
}

function redisCommand(redisUrl, args) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(redisUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const isTls = url.protocol === "rediss:";
    if (!["redis:", "rediss:", "valkey:", "valkeys:"].includes(url.protocol)) {
      reject(new Error("unsupported cache URL protocol"));
      return;
    }
    const socketFactory = isTls || url.protocol === "valkeys:" ? createTlsConnection : createConnection;
    const socket = socketFactory({
      host: url.hostname,
      port: Number(url.port || 6379),
      servername: url.hostname,
    });
    let buffer = Buffer.alloc(0);
    let settled = false;
    let expectedReplies = 1;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(1500, () => done(new Error("weather cache timed out")));
    socket.on("error", done);
    socket.on(isTls || url.protocol === "valkeys:" ? "secureConnect" : "connect", () => {
      const commands = [];
      if (url.password) {
        if (url.username) {
          commands.push(["AUTH", decodeURIComponent(url.username), decodeURIComponent(url.password)]);
        } else {
          commands.push(["AUTH", decodeURIComponent(url.password)]);
        }
      }
      commands.push(args);
      expectedReplies = commands.length;
      socket.write(commands.map(encodeRespArray).join(""));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseResp(buffer);
      if (parsed.complete && parsed.values.length >= expectedReplies) {
        const values = parsed.values;
        done(null, values[values.length - 1]);
      }
    });
  });
}

function encodeRespArray(values) {
  return `*${values.length}\r\n${values
    .map((value) => {
      const text = String(value);
      return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
    })
    .join("")}`;
}

function parseResp(buffer) {
  const values = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = parseRespValue(buffer, offset);
    if (!parsed) {
      return { complete: false };
    }
    values.push(parsed.value);
    offset = parsed.offset;
  }
  return { complete: values.length > 0, values, value: values.length === 1 ? values[0] : values };
}

function parseRespValue(buffer, offset) {
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) {
    return null;
  }
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  if (type === "+") {
    return { value: line, offset: lineEnd + 2 };
  }
  if (type === "-") {
    throw new Error(line);
  }
  if (type === ":") {
    return { value: Number(line), offset: lineEnd + 2 };
  }
  if (type === "$") {
    const length = Number(line);
    if (length < 0) {
      return { value: null, offset: lineEnd + 2 };
    }
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) {
      return null;
    }
    return { value: buffer.toString("utf8", start, end), offset: end + 2 };
  }
  return null;
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export async function pollChatJob(jobId, config = configFromEnv(), fetchImpl = fetch) {
  if (!jobId) {
    throw httpError(400, "job id is required");
  }
  const latest = await controlPlaneFetch(fetchImpl, config, `/v1/jobs/${encodeURIComponent(jobId)}`);
  const job = latest.job ?? latest;
  const formatted = formatChatJob(jobId, job, job.model ?? config.modelOverride ?? null);
  if (formatted.status !== "completed") {
    return formatted;
  }

  const sources = await lookupGroundingSources(jobId, config);
  if (!sources) {
    return formatted;
  }

  logGroundingCitationCheck(jobId, formatted.output, sources);
  return { ...formatted, tool: "web_search", sources };
}

function logGroundingCitationCheck(jobId, output, sources) {
  const hasCitationMarker = /\[[1-9]\d*\]/.test(output);
  const outputWords = new Set(significantWords(output));
  const sourceWords = sources.flatMap((source) => significantWords(source.snippet));
  const overlapCount = sourceWords.filter((word) => outputWords.has(word)).length;
  const overlapRatio = sourceWords.length ? overlapCount / sourceWords.length : 0;
  if (!hasCitationMarker && overlapRatio < 0.1) {
    console.warn(
      `[grounding-check] job ${jobId} answer may not be grounded in provided sources (citations: ${hasCitationMarker}, overlap: ${overlapRatio.toFixed(2)})`,
    );
  }
}

async function waitForChatJob(jobId, body, config, fetchImpl) {
  const timeoutSeconds = positiveInteger(body?.timeoutSeconds, config.defaultTimeoutSeconds);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await pollChatJob(jobId, config, fetchImpl);
    if (latest.status === "completed") {
      return latest;
    }
    if (latest.status === "failed") {
      throw httpError(502, latest.error || "MundusX job failed");
    }
    await delay(POLL_INTERVAL_MS);
  }

  const status = latest?.status ?? "unknown";
  throw httpError(504, `timed out waiting for job ${jobId} while status was ${status}`);
}

function formatChatJob(jobId, job, fallbackModel) {
  const progress = summarizeChatProgress(job);
  const rawOutput = job.status === "completed" ? cleanChatOutput(job.output ?? "") : "";
  const output = job.status === "completed" ? promoteSectionOutputWhenFinalIsThin(rawOutput, progress) : "";
  return {
    job_id: jobId,
    status: job.status,
    output,
    output_cleaned: job.status === "completed" && output !== String(job.output ?? ""),
    error: job.error ?? null,
    model: job.model ?? fallbackModel,
    assigned_node_id: job.assigned_node_id ?? null,
    execution_mode: job.execution_mode ?? "single",
    graph_execution_enabled: Boolean(job.graph_execution_enabled),
    response: job.response ?? null,
    progress,
  };
}

function promoteSectionOutputWhenFinalIsThin(output, progress) {
  if (!isThinFinalOutput(output)) {
    return output;
  }
  const sectionOutput = mergedCompletedSectionOutputs(progress);
  return sectionOutput || output;
}

function isThinFinalOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) {
    return true;
  }
  const withoutHeadings = text
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/[-*_`#\s]/g, "")
    .trim();
  return text.length < 120 && withoutHeadings.length < 40;
}

function mergedCompletedSectionOutputs(progress) {
  const nodes = Array.isArray(progress?.nodes) ? progress.nodes : [];
  const sections = nodes
    .filter((node) => node.status === "completed")
    .filter((node) => String(node.responsibility ?? "section") !== "merge")
    .filter((node) => String(node.output ?? "").trim())
    .map((node) => `## ${node.name || "Section"}\n${node.output.trim()}`);
  return sections.length ? sections.join("\n\n") : "";
}

function summarizeChatProgress(job) {
  const graph = job.graph ?? {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const parentStatus = String(job.status ?? "").toLowerCase();
  if (!nodes.length) {
      return {
        total: 0,
        completed: 0,
      running: ["assigned", "running"].includes(parentStatus) ? 1 : 0,
      failed: 0,
      waiting: parentStatus === "queued" ? 1 : 0,
        processing: ["assigned", "running"].includes(parentStatus)
          ? `Direct response${job.assigned_node_id ? ` on ${job.assigned_node_id}` : ""}`
          : null,
        merging: false,
        final_synthesis: false,
        strategy: job.plan?.strategy ?? "single_job",
      };
  }

  const graphExecutionEnabled = Boolean(job.graph_execution_enabled);
  const singleDirectNode = !graphExecutionEnabled && nodes.length === 1;
  const effectiveNodes = singleDirectNode
    ? nodes.map((node) => ({
        ...node,
        status: parentStatus || node.status,
        assigned_node_id: node.assigned_node_id ?? job.assigned_node_id ?? null,
        completed_at: node.completed_at ?? job.completed_at ?? null,
        output: node.output ?? job.output ?? null,
      }))
    : nodes;

  const completed = effectiveNodes.filter((node) => node.status === "completed").length;
  const runningNodes = effectiveNodes.filter((node) => node.status === "running" || node.status === "assigned");
  const failed = effectiveNodes.filter((node) => node.status === "failed").length;
  const waiting = effectiveNodes.filter((node) => node.status === "waiting" || node.status === "ready" || node.status === "queued").length;
  const activeNode =
    effectiveNodes.find((node) => node.id === job.active_graph_node_id) ?? runningNodes[0] ?? null;
    const finalNodeId = graph.final_node_id ?? null;
  const merging =
    Boolean(activeNode) &&
    (activeNode.id === finalNodeId || String(activeNode.responsibility ?? "") === "merge");
  const nodeNameById = Object.fromEntries(
    effectiveNodes.map((node) => [node.id, node.name || node.id]),
  );

    return {
      total: effectiveNodes.length,
      completed,
      running: runningNodes.length,
      failed,
      waiting,
      processing: activeNode?.name ?? null,
      merging,
      final_synthesis: Boolean(finalNodeId),
      strategy: job.plan?.strategy ?? graph.strategy ?? "graph",
      nodes: effectiveNodes.map((node) => formatChatProgressNode(node, job, nodeNameById)),
    };
}

function formatChatProgressNode(node, job, nodeNameById = {}) {
  const completed = node.status === "completed";
  const rawOutput = completed ? String(node.output ?? "") : "";
  const compactOutput = rawOutput ? compactChunkOutput(rawOutput) : "";
  const outputChars = positiveNumberOrNull(node.output_chars) ?? (compactOutput ? compactOutput.length : null);
  const estimatedOutputTokens =
    positiveNumberOrNull(node.estimated_output_tokens) ?? estimateDisplayTokens(compactOutput);
  const effectiveMaxTokens =
    positiveNumberOrNull(node.effective_max_tokens) ??
    positiveNumberOrNull(job.effective_max_tokens) ??
    positiveNumberOrNull(job.max_tokens);

  return {
    id: node.id,
    name: node.name,
    status: node.status,
    responsibility: node.responsibility ?? null,
    depends_on: Array.isArray(node.depends_on) ? node.depends_on.map((id) => nodeNameById[id] || id) : [],
    blocked_by: Array.isArray(node.blocked_by) ? node.blocked_by.map((id) => nodeNameById[id] || id) : [],
    assigned_node_id: node.assigned_node_id ?? null,
    latency_ms: positiveNumberOrNull(node.latency_ms),
    queue_wait_ms: positiveNumberOrNull(node.queue_wait_ms),
    runtime_ms: positiveNumberOrNull(node.runtime_ms),
    output_chars: outputChars,
    estimated_output_tokens: estimatedOutputTokens,
    effective_max_tokens: effectiveMaxTokens,
    output: compactOutput,
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumberOrNull(value) {
  const number = numberOrNull(value);
  return number && number > 0 ? number : null;
}

function estimateDisplayTokens(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function compactChunkOutput(value) {
  const cleaned = cleanChatOutputInternal(value, false);
  if (isInstructionOnlyChunkOutput(cleaned)) {
    return "";
  }
  return truncateText(cleaned, 900);
}

function isInstructionOnlyChunkOutput(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return true;
  }
  const sentences = text.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean);
  if (!sentences.length) {
    return false;
  }
  const instructionSentences = sentences.filter((sentence) =>
    sentence.startsWith("do not ") ||
    sentence.startsWith("don't ") ||
    sentence.startsWith("avoid ") ||
    sentence.startsWith("return only ") ||
    sentence.startsWith("not include "),
  );
  return instructionSentences.length / sentences.length >= 0.75;
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function normalizeExecutionMode(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (["single", "auto", "decompose"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function inferMaxTokens(message, explicitValue, capacityProfile = null) {
  const explicit = positiveInteger(explicitValue, 0);
  if (explicit > 0) {
    return explicit;
  }

  const lower = message.toLowerCase();
  if (looksLikeCompleteProgramRequest(lower)) {
    return adaptiveTokenBudget("code", 4096, capacityProfile);
  }
  if (
    containsAny(lower, [
      "one word",
      "one-word",
      "answer only",
      "only with",
      "final number",
      "just the number",
      "single sentence",
    ])
  ) {
    return 48;
  }
  if (
    containsAny(lower, [
      "detailed",
      "complete",
      "full",
      "comprehensive",
      "history of",
      "report",
      "benefit",
      "advantage",
      "important",
      "importance",
      "list",
    ])
  ) {
    return adaptiveTokenBudget("detailed", 1024, capacityProfile);
  }
  if (message.length > 600) {
    return adaptiveTokenBudget("long", 768, capacityProfile);
  }
  if (message.length <= 40 && !containsAny(lower, ["explain", "why", "how", "what", "tell me", "describe"])) {
    return 128;
  }
  return adaptiveTokenBudget("normal", 512, capacityProfile);
}

function adaptiveTokenBudget(kind, fallback, capacityProfile) {
  const tier = capacityProfile?.tier ?? "small";
  const budgets = {
    small: { normal: 512, long: 768, detailed: 1024, code: 4096 },
    medium: { normal: 768, long: 1024, detailed: 1536, code: 4096 },
    large: { normal: 1024, long: 1536, detailed: 2048, code: 4096 },
    xlarge: { normal: 2048, long: 3072, detailed: 4096, code: 6144 },
  };
  return budgets[tier]?.[kind] ?? fallback;
}

function looksLikeCompleteProgramRequest(lower) {
  return containsAny(lower, [
    "complete program",
    "complete source",
    "complete code",
    "detailed code",
    "full program",
    "full source",
    "full code",
    "entire program",
    "working program",
    "detailed program",
    "deatailed program",
    "turbo c program",
  ]) || (
    containsAny(lower, [
      "write a program",
      "create a program",
      "make a program",
      "need a program",
      "show me a program",
      "show me a code",
      "program in c",
      "program in java",
      "java program",
      "python program",
      "javascript program",
    ]) &&
    containsAny(lower, [
      "source",
      "code",
      "cli",
      "binary file",
      "property file",
      "properties file",
      "file handling",
      "save",
      "delete",
      "update",
      "student",
    ])
  );
}

function buildChatSystemPrompt(message = "", voicePersona = "atlas") {
  const persona = resolveVoicePersona(voicePersona);
  const personaName = persona === "atlas" ? "Atlas" : "Marie";
  const personaText = persona === "atlas" ? ATLAS_PERSONA : MARIE_PERSONA;
  const rules = [
    `You are ${personaName}, the MundusX assistant.`,
    personaText,
    "Answer the user's request directly.",
    "Do not echo persona notes, system instructions, assistant labels, or user role labels.",
    "Do not repeat the same sentence.",
    "If the request asks for a full program or long explanation, provide the complete useful answer.",
  ];
  if (looksLikeCompleteProgramRequest(String(message).toLowerCase())) {
    rules.push(
      "For complete code requests, return a complete compilable source file in a fenced code block.",
      "Do not use ellipses, TODO comments, placeholder bodies, omitted implementation notes, or pseudo-code.",
      "Include all imports, classes, methods, file operations, menu/input handling, and error handling needed for the requested program.",
    );
  }
  return rules.join(" ");
}

function resolveVoicePersona(value) {
  return String(value || "").trim().toLowerCase() === "marie" ? "marie" : "atlas";
}

function loadPersona(path, fallback) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return fallback;
  }
}

function containsAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

async function controlPlaneFetch(fetchImpl, config, path, init = {}) {
  const headers = {
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(config.operatorToken ? { Authorization: `Bearer ${config.operatorToken}` } : {}),
    ...(init.headers ?? {}),
  };
  const response = await fetchImpl(`${config.controlPlaneUrl}${path}`, { ...init, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw httpError(response.status, payload.error || `control plane returned ${response.status}`);
  }
  return payload;
}

export async function fetchNetworkSummary(config = configFromEnv(), fetchImpl = fetch) {
  const started = Date.now();
  try {
    const status = await controlPlaneFetch(fetchImpl, config, "/v1/status");
    const snapshot = status.snapshot ?? status;
    return {
      status: "ok",
      control_plane_url: config.controlPlaneUrl,
      model_routing: "control-plane",
      latency_ms: Math.max(1, Date.now() - started),
      online_count: numberField(snapshot.online_count),
      trusted_count: numberField(snapshot.trusted_count),
      paused_count: numberField(snapshot.paused_count),
      queued_job_count: numberField(snapshot.queued_job_count),
      assigned_job_count: numberField(snapshot.assigned_job_count),
      completed_job_count: numberField(snapshot.completed_job_count),
      failed_job_count: numberField(snapshot.failed_job_count),
    };
  } catch (error) {
    return {
      status: "degraded",
      control_plane_url: config.controlPlaneUrl,
      model_routing: "control-plane",
      error: error.message ?? "network summary unavailable",
      latency_ms: Math.max(1, Date.now() - started),
      online_count: 0,
      trusted_count: 0,
      paused_count: 0,
      queued_job_count: 0,
      assigned_job_count: 0,
      completed_job_count: 0,
      failed_job_count: 0,
    };
  }
}

function numberField(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(httpError(413, "request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(httpError(400, "invalid json body"));
      }
    });
    request.on("error", reject);
  });
}

function sendHtml(response, html) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendPng(response, bytes) {
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  });
  response.end(bytes);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function cleanChatOutput(value) {
  return cleanChatOutputInternal(value, true);
}

function cleanChatOutputInternal(value, emptyFallback) {
  let output = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

  output = stripWorkerTrace(output);
  output = stripRolePrefixes(output);
  output = stripPersonaLabelLeak(output);
  output = stripAssistantPreamble(output);
  output = stripEmbeddedRoleLeak(output);
  output = stripPromptInstructionLeak(output);
  output = stripSystemPromptLeak(output);
  output = collapseRepeatedOpeningClause(output);
  output = collapseRepeatedSentences(output);
  output = collapseRepeatedLines(output);
  output = output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (isIncompletePlaceholderCode(output)) {
    return "MundusX returned incomplete placeholder code. Please retry the request; complete-code jobs must return a full compilable source file, not stubs or ellipses.";
  }

  if (!output) {
    return emptyFallback ? "MundusX returned an empty response. Please try again." : "";
  }
  return output;
}

function isIncompletePlaceholderCode(value) {
  const text = String(value ?? "").trim();
  if (!text || !looksLikeCodeOutput(text)) {
    return false;
  }
  const placeholderMatches = text.match(
    /(?:\/\/\s*(?:\.\.\.|todo|add .* here|implement .* here|save\.\.\.|load\.\.\.|delete .* here)|\/\*\s*(?:\.\.\.|todo|implement|placeholder)[\s\S]*?\*\/|\b(?:TODO|TBD)\b|\.{3,})/gi,
  ) ?? [];
  if (placeholderMatches.length < 2) {
    return false;
  }
  const substantiveLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line));
  const placeholderLineCount = substantiveLines.filter((line) =>
    /(?:\/\/\s*(?:\.\.\.|todo|add .* here|implement .* here|save\.\.\.|load\.\.\.|delete .* here)|\/\*|\b(?:TODO|TBD)\b|\.{3,})/i.test(line),
  ).length;
  return placeholderLineCount >= 2 || placeholderMatches.length >= 2;
}

function looksLikeCodeOutput(value) {
  const text = String(value ?? "");
  return /\b(public\s+class|class\s+\w+|import\s+java\.|#include\s*<|function\s+\w+\s*\(|const\s+\w+\s*=|def\s+\w+\s*\()/m.test(text) &&
    (text.match(/[;{}]/g) || []).length >= 4;
}

function stripWorkerTrace(value) {
  const responseIndex = value.search(/(?:^|;\s*)response=/i);
  if (responseIndex === -1) {
    return value;
  }

  const responsePrefix = value.slice(responseIndex).match(/^(?:;\s*)?response=/i)?.[0] ?? "";
  return value.slice(responseIndex + responsePrefix.length).trim();
}

function stripRolePrefixes(value) {
  let output = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = output.replace(/^(?:system|assistant|user|mundusx chat)\s*:\s*/i, "").trim();
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function collapseRepeatedOpeningClause(value) {
  const output = String(value ?? "").trim();
  const match = output.match(/^(.{20,260}?\b(?:is|are|was|were|allows|enables|uses|provides)\b.{20,260}?[.!?])\s+\1/i);
  if (!match) {
    return output;
  }
  return `${match[1]} ${output.slice(match[0].length).trim()}`.trim();
}

function stripPersonaLabelLeak(value) {
  let output = value.trim();
  for (let i = 0; i < 2; i += 1) {
    const next = output
      .replace(/^(?:marie|atlas)\s*:\s*/i, "")
      .replace(/^[^\n:]{1,140}\?\s*(?:marie|atlas)\s*:\s*/i, "")
      .trim();
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripAssistantPreamble(value) {
  return value
    .trim()
    .replace(
      /^(?:(?:certainly|sure|of course)[!.]?\s+)?(?:here(?:'s| is)\s+(?:a|an|the)?\s*(?:brief|detailed|complete)?\s*(?:answer|overview|summary|history|response|program|code)?(?:\s+of\s+[^:]{2,120})?\s*:\s*)/i,
      "",
    )
    .trim();
}

function stripEmbeddedRoleLeak(value) {
  const roleMatch = value.match(/\s(?:system|assistant|user)\s*:\s*/i);
  if (!roleMatch || roleMatch.index === undefined) {
    return value;
  }

  const before = value.slice(0, roleMatch.index).trim();
  const after = value.slice(roleMatch.index + roleMatch[0].length).trim();
  if (!after) {
    return before;
  }

  if (!before || before.endsWith("?") || before.length < 24) {
    return after;
  }

  return before;
}

function stripPromptInstructionLeak(value) {
  let output = value.trim();
  if (!output) {
    return output;
  }

  const codeSubjobIndex = output.search(/\bmundusx code subjob\s*:/i);
  if (codeSubjobIndex !== -1) {
    const codeOutput = stripCodeSubjobLeak(output.slice(codeSubjobIndex));
    if (codeOutput) {
      return codeOutput;
    }
  }

  const requiredOutputIndex = output.search(/\brequired output\s*:/i);
  if (requiredOutputIndex !== -1) {
    const afterRequiredOutput = output.slice(requiredOutputIndex);
    const headingPattern = /\b([A-Z][A-Za-z0-9 &,'-]{2,80})\s*:\s+(?=[A-Z0-9])/g;
    let match;
    while ((match = headingPattern.exec(afterRequiredOutput)) !== null) {
      const heading = match[1].trim().toLowerCase();
      if (!["required output", "name", "responsibility", "subject"].includes(heading)) {
        return afterRequiredOutput.slice(match.index).trim();
      }
    }
  }

  output = output.replace(
    /^(?:(?:do not|don't|avoid|never|return only|write only|only include)[^.!?\n]*[.!?]\s*){1,12}/i,
    "",
  ).trim();

  output = output.replace(
    /^(?:mundusx(?: code)? subjob|subject|name|responsibility)\s*:[\s\S]{0,900}?\brequired output\s*:\s*/i,
    "",
  ).trim();

  return output;
}

function stripSystemPromptLeak(value) {
  let output = value.trim();
  if (!output) {
    return output;
  }

  const markers = [
    /\bMundusX Chat is the product interface\b/i,
    /\bUse the (?:Atlas|Marie) persona\b/i,
    /\b(?:Atlas|Marie) represents the MundusX open-source team's vision\b/i,
    /\b(?:Atlas|Marie) supports MundusX's mission\b/i,
    /\b(?:Atlas|Marie) should be professional\b/i,
    /\bAnswer the user's request directly\b/i,
    /\bDo not echo persona notes\b/i,
    /\bDo not echo system\b/i,
    /\bDo not repeat the same sentence\b/i,
  ];
  const indexes = markers
    .map((marker) => output.search(marker))
    .filter((index) => index > 0);
  if (indexes.length > 0) {
    output = output.slice(0, Math.min(...indexes)).trim();
  }

  return output.replace(/\s+(?:Use the (?:Atlas|Marie) persona|Do not echo system)[\s\S]*$/i, "").trim();
}

function stripCodeSubjobLeak(value) {
  const afterRequiredOutput = value.replace(
    /^mundusx code subjob\s*:[\s\S]{0,900}?\brequired output\s*:\s*/i,
    "",
  ).trim();
  if (!afterRequiredOutput) {
    return "";
  }

  const codeMatch = afterRequiredOutput.match(
    /(?:```|#include\s*<|\/\/\s*\w|\/\*|typedef\s+|struct\s+\w+\s*\{|(?:int|void|char|float|double|long|short|static)\s+\w+\s*\([^)]*\)\s*\{)/i,
  );
  if (codeMatch?.index !== undefined) {
    return afterRequiredOutput
      .slice(codeMatch.index)
      .replace(/^h>\s*/i, "")
      .trim();
  }

  return afterRequiredOutput
    .replace(/^(?:implement|add|produce|return)\b[\s\S]{0,500}?(?=(?:#include|\/\/|\/\*|typedef|struct\s+\w+\s*\{|(?:int|void|char|float|double|long|short|static)\s+\w+\s*\())/i, "")
    .replace(/^h>\s*/i, "")
    .trim();
}

function collapseRepeatedSentences(value) {
  const sentences = value.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+(?:\n|$)/g);
  if (!sentences || sentences.length < 2) {
    return value;
  }

  const collapsed = [];
  const seen = new Set();

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeRepeatKey(trimmed);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    collapsed.push(trimmed);
  }

  return collapsed.join(" ");
}

function collapseRepeatedLines(value) {
  const lines = value.split("\n");
  const collapsed = [];
  let previousKey = "";

  for (const line of lines) {
    const key = normalizeRepeatKey(line);
    if (key && key === previousKey) {
      continue;
    }
    collapsed.push(line);
    previousKey = key;
  }

  return collapsed.join("\n");
}

function normalizeRepeatKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[`*_()[\]{}\\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOrigin(value) {
  return String(value || DEFAULT_CONTROL_PLANE_URL).replace(/\/+$/, "");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = configFromEnv();
  createServerApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(`MundusX chat listening on http://127.0.0.1:${config.port}`);
    console.log(`controlPlaneUrl: ${config.controlPlaneUrl}`);
  });
}
