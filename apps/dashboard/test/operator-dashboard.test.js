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
            summary: "Planned sectioned research units plus a final reducer.",
          },
          graph: {
            nodes: [
              { name: "Origins and founders", status: "completed", blocked_by: [] },
              { name: "Modern era", status: "running", blocked_by: [] },
              { name: "Final synthesis", status: "waiting", blocked_by: ["job.modern_era"] },
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
  assert.match(html, /1\/3 chunks complete/i);
  assert.match(html, /Origins and founders/i);
  assert.match(html, /Modern era/i);
  assert.match(html, /Blocked by job\.modern_era/i);
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

  assert.match(html, /MundusX Command Deck/i);
  assert.match(html, /Control Plane/i);
  assert.match(html, /MundusX control plane logo/i);
  assert.match(html, /\/assets\/mundusx-logo\.png/);
  assert.match(html, /motion-lift/);
  assert.match(html, /motion-glow/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(html, /Live command summary/i);
  assert.match(html, /<strong>2<\/strong><span>nodes<\/span>/);
  assert.match(html, /<strong>5<\/strong><span>active jobs<\/span>/);
  assert.match(html, /<strong>9<\/strong><span>events<\/span>/);
});
