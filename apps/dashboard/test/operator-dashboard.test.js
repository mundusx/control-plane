import test from "node:test";
import assert from "node:assert/strict";

import { page } from "../src/main.js";

test("renders an operator-focused M-series summary section", () => {
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 2,
      nodes: [
        {
          node_id: "mac-mini-01",
          public_key_fingerprint: "abcd1234",
          hostname: "mac-mini-01",
          backend: "m",
          contribution_percent: 70,
          state: "ready",
          available_memory_mb: 16384,
          available_gpu_percent: 82,
          identity_trust_path: "keychain",
          power_source: "AC",
          on_battery: false,
          battery_percent: 100,
          policy_allowed: true,
          policy_reason: null,
          worker_health: {
            healthy: true,
            model_dir: "/Users/test/.mundusx/models",
            model_name: "SmolLM2",
            model_path: "/Users/test/.mundusx/models/SmolLM2.gguf",
            llama_cli_available: true,
            blas_device_available: true,
            runtime_mode: "local",
            checked_at: "2026-05-31T16:00:00Z",
            notes: ["ready for local jobs"],
          },
          updated_at: "2026-05-31T16:00:00Z",
        },
      ],
      jobs: [],
    },
    events: [],
    credits: {},
    error: null,
  });

  assert.match(html, /M-series operator view/i);
  assert.match(html, /Routing risk/i);
  assert.match(html, /Runtime readiness/i);
});

test("renders operator cap overrides separately from reported caps", () => {
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 0,
      nodes: [
        {
          node_id: "mac-mini-01",
          public_key_fingerprint: "abcd1234",
          hostname: "mac-mini-01",
          backend: "m",
          contribution_percent: 80,
          reported_contribution_percent: 35,
          operator_contribution_percent: 80,
          state: "ready",
          available_memory_mb: 16384,
          available_gpu_percent: 82,
          identity_trust_path: "keychain",
          power_source: "AC",
          on_battery: false,
          battery_percent: 100,
          policy_allowed: true,
          policy_reason: null,
          worker_health: {
            healthy: true,
            model_dir: "/Users/test/.mundusx/models",
            model_name: "SmolLM2",
            model_path: "/Users/test/.mundusx/models/SmolLM2.gguf",
            llama_cli_available: true,
            blas_device_available: true,
            runtime_mode: "local",
            checked_at: "2026-05-31T16:00:00Z",
            notes: ["ready for local jobs"],
          },
          updated_at: "2026-05-31T16:00:00Z",
        },
      ],
      jobs: [],
    },
    events: [],
    credits: {},
    error: null,
  });

  assert.match(html, /operator cap 80%/i);
  assert.match(html, /agent reported 35%/i);
});

test("renders node policy override details separately from computed policy", () => {
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 1,
      nodes: [
        {
          node_id: "mac-mini-01",
          public_key_fingerprint: "abcd1234",
          hostname: "mac-mini-01",
          backend: "m",
          contribution_percent: 80,
          reported_contribution_percent: 35,
          operator_contribution_percent: 80,
          state: "paused",
          reported_state: "ready",
          available_memory_mb: 16384,
          available_gpu_percent: 82,
          identity_trust_path: "keychain",
          power_source: "AC",
          on_battery: false,
          battery_percent: 100,
          policy_allowed: false,
          policy_reason: "operator override: operator drained the node",
          computed_policy_allowed: true,
          computed_policy_reason: null,
          operator_policy_override: {
            target: "paused",
            reason: "operator drained the node",
            actor: "automation",
            updated_at: "2026-06-01T21:00:00Z",
          },
          worker_health: {
            healthy: true,
            model_dir: "/Users/test/.mundusx/models",
            model_name: "SmolLM2",
            model_path: "/Users/test/.mundusx/models/SmolLM2.gguf",
            llama_cli_available: true,
            blas_device_available: true,
            runtime_ready: true,
            runtime_mode: "local",
            checked_at: "2026-05-31T16:00:00Z",
            notes: ["ready for local jobs"],
          },
          updated_at: "2026-05-31T16:00:00Z",
        },
      ],
      jobs: [],
    },
    events: [],
    credits: {},
    error: null,
  });

  assert.match(html, /override paused/i);
  assert.match(html, /operator drained the node/i);
  assert.match(html, /automation/i);
  assert.match(html, /computed policy allows work/i);
});

test("renders the live deploy fingerprint from health", () => {
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
      deploy_fingerprint: "abcdef1234567890",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 0,
      nodes: [],
      jobs: [],
    },
    events: [],
    credits: {},
    error: null,
  });

  assert.match(html, /deploy:\s*abcdef1234567890/i);
});

test("renders chunk plan progress for decomposed jobs", () => {
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 1,
      nodes: [],
      jobs: [
        {
          job_id: "job-history",
          request_id: "job-history",
          prompt: "Write a history of Mercedes-Benz",
          status: "queued",
          execution_mode: "decompose",
          graph_execution_enabled: true,
          preferred_backend: "auto",
          submitted_at: "1",
          assigned_at: null,
          completed_at: null,
          plan: {
            strategy: "sectioned_research",
            summary:
              "Planned 3 sectioned research units. Sections are returned directly; final synthesis is optional.",
          },
          graph: {
            nodes: [
              { name: "Origins and founders", status: "completed", blocked_by: [] },
              { name: "Modern era", status: "running", blocked_by: [] },
              { name: "Expansion and milestones", status: "waiting", blocked_by: ["job.modern_era"] },
            ],
          },
        },
      ],
    },
    events: [],
    credits: {},
    error: null,
  });

  assert.match(html, /mode decompose/i);
  assert.match(html, /graph enabled/i);
  assert.match(html, /Request hidden for privacy/);
  assert.doesNotMatch(html, /Write a history of Mercedes-Benz/);
  assert.match(html, /1\/3 sections complete/i);
  assert.match(html, /Origins and founders/i);
  assert.match(html, /Modern era/i);
  assert.match(html, /Blocked by job\.modern_era/i);
});

test("hides request and response content in operator job and event displays", () => {
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 0,
      nodes: [],
      jobs: [
        {
          job_id: "job-secret",
          request_id: "job-secret",
          prompt: "debug password=supersecret123 with key sk-proj-abc123456789XYZ",
          status: "completed",
          preferred_backend: "auto",
          execution_mode: "single",
          graph_execution_enabled: false,
          submitted_at: "1",
          assigned_at: "2",
          completed_at: "3",
        },
      ],
    },
    events: [
      {
        event_type: "completed",
        created_at: "4",
        node_id: "node-1",
        job_id: "job-secret",
        payload: {
          prompt: "Who is David Batalla?",
          output: "Bearer abcdefghijklmnopqrstuvwxyz1234567890",
          nested: { content: "raw user content" },
        },
      },
    ],
    credits: {},
    error: null,
  });

  assert.match(html, /Request hidden for privacy/);
  assert.match(html, /prompt hidden for privacy/);
  assert.match(html, /output hidden for privacy/);
  assert.match(html, /content hidden for privacy/);
  assert.doesNotMatch(
    html,
    /debug password|supersecret123|sk-proj-abc123456789XYZ|Who is David Batalla|abcdefghijklmnopqrstuvwxyz1234567890|raw user content/,
  );
});

test("renders the high-impact command deck shell with replacement logo and live metrics", () => {
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 3,
      assigned_job_count: 2,
      job_events: 9,
      nodes: [{ node_id: "node-1" }, { node_id: "node-2" }],
      jobs: [],
    },
    events: [],
    credits: {},
    error: null,
  });

  assert.match(html, /Command Deck/i);
  assert.match(html, /Control Plane/i);
  assert.match(html, /Control plane logo/i);
  assert.match(html, /\/assets\/mundusx-logo\.png/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:3001\/#nodes"/);
  assert.match(html, /aria-label="Show first 25 nodes and clear filters"/);
  assert.match(html, /<div class="section" id="nodes">/);
  assert.match(html, /motion-lift/);
  assert.match(html, /motion-glow/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(html, /Live command summary/i);
  assert.match(html, /planner-command-tile/);
  assert.match(html, /Planner Service/);
  assert.match(html, /Open planner status/);
  assert.match(html, /provider: rust/);
  assert.match(html, /<strong>2<\/strong><span>nodes<\/span>/);
  assert.match(html, /<strong>5<\/strong><span>active jobs<\/span>/);
  assert.match(html, /<strong>9<\/strong><span>events<\/span>/);
});

test("logo navigation targets a clean nodes view and the node table caps at 25", () => {
  const nodes = Array.from({ length: 26 }, (_, index) => ({
    node_id: `node-${String(index + 1).padStart(2, "0")}`,
    hostname: `host-${index + 1}`,
    backend: "cuda",
    state: "ready",
    policy_allowed: true,
    power_source: "AC",
    on_battery: false,
    battery_percent: 100,
    available_memory_mb: 4096,
    available_gpu_percent: 70,
    updated_at: "2026-07-01T12:00:00Z",
  }));
  const html = page({
    health: {
      status: "ok",
      storage_source: "supabase",
      supabase: "enabled",
    },
    status: {
      storage_source: "supabase",
      queued_job_count: 0,
      nodes,
      jobs: [],
    },
    events: [],
    credits: {},
    error: null,
  });

  assert.match(html, /href="http:\/\/127\.0\.0\.1:3001\/#nodes"/);
  assert.match(html, /Showing the first 25 of 26 nodes/);
  assert.match(html, /node-25/);
  assert.doesNotMatch(html, /node-26/);
});
