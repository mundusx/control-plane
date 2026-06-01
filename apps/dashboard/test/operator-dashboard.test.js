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
