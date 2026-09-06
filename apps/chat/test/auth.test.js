import test from "node:test";
import assert from "node:assert/strict";

import { PostgresAuthStore, authConfigFromEnv } from "../src/auth.js";

test("browser authentication is required by default and uses the pooled database URL", () => {
  const config = authConfigFromEnv({
    MUNDUSX_DATABASE_POOL_URL: "postgresql://pool.example/mundusx",
    DATABASE_URL: "postgresql://direct.example/mundusx",
  });
  assert.equal(config.required, true);
  assert.equal(config.databaseUrl, "postgresql://pool.example/mundusx");
});

test("GitHub access remains disabled until credentials and encryption exist", () => {
  const store = new PostgresAuthStore({
    githubClientId: "client",
    githubClientSecret: "",
    resendApiKey: "key",
    emailFrom: "",
  }, { pool: {} });
  assert.deepEqual(store.providers(), { github: false, google: false, email: false });
});

test("Google provider is enabled only with both OAuth credentials", () => {
  const config = authConfigFromEnv({
    MUNDUSX_GOOGLE_CLIENT_ID: "google-client",
    MUNDUSX_GOOGLE_CLIENT_SECRET: "google-secret",
  });
  assert.equal(new PostgresAuthStore(config, { pool: {} }).providers().google, true);
});

test("Google login starts a bounded PKCE and state flow", async () => {
  let insert;
  const store = new PostgresAuthStore({
    googleClientId: "google-client",
    googleClientSecret: "google-secret",
    publicOrigin: "https://chat.mundusx.ai",
  }, { pool: { async query(sql, values) { insert = { sql, values }; return { rows: [] }; } } });
  const location = new URL(await store.startGoogle("//evil.example"));
  assert.equal(location.origin, "https://accounts.google.com");
  assert.equal(location.searchParams.get("redirect_uri"), "https://chat.mundusx.ai/api/auth/google/callback");
  assert.equal(location.searchParams.get("scope"), "openid email profile");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(insert.values[2], "/");
  assert.match(insert.sql, /google_oauth/);
});

test("Google callback maps a verified subject to a MundusX session without storing tokens", async () => {
  const clientQueries = [];
  const client = { async query(sql) { clientQueries.push(sql); return { rows: [] }; }, release() {} };
  const pool = {
    async query() { return { rowCount: 1, rows: [{ code_verifier: "verifier", redirect_path: "/skills" }] }; },
    async connect() { return client; },
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return url.includes("/token")
      ? { ok: true, async json() { return { access_token: "short-lived-token" }; } }
      : { ok: true, async json() { return { sub: "google-subject", email: "User@Example.com", email_verified: true, name: "Example User" }; } };
  };
  const store = new PostgresAuthStore({
    googleClientId: "google-client", googleClientSecret: "google-secret", publicOrigin: "https://chat.mundusx.ai",
  }, { pool, fetchImpl });
  let identity;
  let session;
  store.upsertIdentity = async (_client, value) => { identity = value; return "user-id"; };
  store.createSession = async (_response, userId, provider) => { session = { userId, provider }; };
  const destination = await store.finishGoogle(new URLSearchParams({ state: "state", code: "code" }), {});
  assert.equal(destination, "/skills");
  assert.deepEqual(identity, { provider: "google", subject: "google-subject", email: "user@example.com", displayName: "Example User", profile: { picture: null } });
  assert.deepEqual(session, { userId: "user-id", provider: "google" });
  assert.equal(requests.length, 2);
  assert.match(String(requests[0].options.body), /code_verifier=verifier/);
  assert.deepEqual(clientQueries, ["begin", "commit"]);
});

test("Google callback rejects an account without a verified email", async () => {
  let connected = false;
  const pool = {
    async query() { return { rowCount: 1, rows: [{ code_verifier: "verifier", redirect_path: "/" }] }; },
    async connect() { connected = true; throw new Error("must not create a session"); },
  };
  const fetchImpl = async (url) => url.includes("/token")
    ? { ok: true, async json() { return { access_token: "short-lived-token" }; } }
    : { ok: true, async json() { return { sub: "google-subject", email: "user@example.com", email_verified: false }; } };
  const store = new PostgresAuthStore({
    googleClientId: "google-client", googleClientSecret: "google-secret", publicOrigin: "https://chat.mundusx.ai",
  }, { pool, fetchImpl });
  await assert.rejects(
    store.finishGoogle(new URLSearchParams({ state: "state", code: "code" }), {}),
    (error) => error.statusCode === 403 && /verified email/.test(error.message),
  );
  assert.equal(connected, false);
});

test("Google callback accepts the verified_email compatibility claim", async () => {
  const client = { async query() { return { rows: [] }; }, release() {} };
  const pool = {
    async query() { return { rowCount: 1, rows: [{ code_verifier: "verifier", redirect_path: "/projects" }] }; },
    async connect() { return client; },
  };
  const store = new PostgresAuthStore({
    googleClientId: "google-client", googleClientSecret: "google-secret", publicOrigin: "https://chat.mundusx.ai",
  }, {
    pool,
    fetchImpl: async (url) => String(url).includes("/token")
      ? { ok: true, async json() { return { access_token: "access" }; } }
      : { ok: true, async json() { return { sub: "google-subject", email: "User@Example.com", verified_email: true, name: "Example User" }; } },
  });
  let identity;
  store.upsertIdentity = async (_client, value) => { identity = value; return "user-id"; };
  store.createSession = async () => {};
  const destination = await store.finishGoogle(new URLSearchParams({ state: "state", code: "code" }), {});
  assert.equal(destination, "/projects");
  assert.equal(identity.email, "user@example.com");
});

test("Google callback accepts a matching verified-email ID token when userinfo omits the claim", async () => {
  const client = { async query() { return { rows: [] }; }, release() {} };
  const pool = {
    async query() { return { rowCount: 1, rows: [{ code_verifier: "verifier", redirect_path: "/projects" }] }; },
    async connect() { return client; },
  };
  const claims = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "google-client",
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: "google-subject",
    email: "User@Example.com",
    email_verified: true,
  })).toString("base64url");
  const store = new PostgresAuthStore({
    googleClientId: "google-client", googleClientSecret: "google-secret", publicOrigin: "https://chat.mundusx.ai",
  }, {
    pool,
    fetchImpl: async (url) => String(url).includes("/token")
      ? { ok: true, async json() { return { access_token: "access", id_token: `header.${claims}.signature` }; } }
      : { ok: true, async json() { return { sub: "google-subject", email: "user@example.com", name: "Example User" }; } },
  });
  let identity;
  store.upsertIdentity = async (_client, value) => { identity = value; return "user-id"; };
  store.createSession = async () => {};
  assert.equal(await store.finishGoogle(new URLSearchParams({ state: "state", code: "code" }), {}), "/projects");
  assert.equal(identity.email, "user@example.com");
});

test("Google callback rejects a verified ID-token claim that does not match userinfo", async () => {
  const pool = {
    async query() { return { rowCount: 1, rows: [{ code_verifier: "verifier", redirect_path: "/" }] }; },
    async connect() { throw new Error("must not create a session"); },
  };
  const claims = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "different-client",
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: "google-subject",
    email: "user@example.com",
    email_verified: true,
  })).toString("base64url");
  const store = new PostgresAuthStore({
    googleClientId: "google-client", googleClientSecret: "google-secret", publicOrigin: "https://chat.mundusx.ai",
  }, {
    pool,
    fetchImpl: async (url) => String(url).includes("/token")
      ? { ok: true, async json() { return { access_token: "access", id_token: `header.${claims}.signature` }; } }
      : { ok: true, async json() { return { sub: "google-subject", email: "user@example.com" }; } },
  });
  await assert.rejects(
    store.finishGoogle(new URLSearchParams({ state: "state", code: "code" }), {}),
    (error) => error.statusCode === 403 && /verified email/.test(error.message),
  );
});

test("GitHub provider requires a valid 32-byte encryption key", () => {
  const config = authConfigFromEnv({
    MUNDUSX_GITHUB_CLIENT_ID: "client",
    MUNDUSX_GITHUB_CLIENT_SECRET: "secret",
    MUNDUSX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  assert.equal(new PostgresAuthStore(config, { pool: {} }).providers().github, true);
});

test("repository normalization preserves live pull and push permissions", () => {
  const store = new PostgresAuthStore({}, { pool: {} });
  assert.deepEqual(store.normalizeRepository({
    id: 42,
    full_name: "owner/repo",
    private: true,
    default_branch: "trunk",
    permissions: { pull: true, push: false, admin: false },
  }), {
    id: 42,
    installation_id: null,
    full_name: "owner/repo",
    private: true,
    default_branch: "trunk",
    permissions: { pull: true, push: false, admin: false },
  });
});

test("new Java repositories are private user-owned projects with bounded Maven policy", async () => {
  let githubRequest;
  let policyInsert;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) { policyInsert = { sql, values }; return { rows: [] }; },
  } });
  store.githubJson = async (_userId, url, options) => {
    githubRequest = { url, options };
    return {
      id: 84,
      full_name: "alice/my-java-program",
      private: true,
      default_branch: "main",
      owner: { login: "alice" },
      permissions: { pull: true, push: true, admin: true },
    };
  };

  const result = await store.createRepository("user-alice", {
    name: "my-java-program",
    description: "A tested Java project",
    template: "java-maven",
  });

  assert.equal(githubRequest.url, "https://api.github.com/user/repos");
  assert.equal(githubRequest.options.method, "POST");
  assert.deepEqual(githubRequest.options.body, {
    name: "my-java-program",
    description: "A tested Java project",
    private: true,
    auto_init: true,
  });
  assert.equal(result.repository.full_name, "alice/my-java-program");
  assert.equal(policyInsert.values[1], "alice/my-java-program");
  assert.equal(policyInsert.values[2], "user:user-alice");
  assert.deepEqual(policyInsert.values[3], ["src", "pom.xml", "README.md", ".gitignore"]);
  assert.deepEqual(policyInsert.values[4], ["java-maven-test"]);
  assert.deepEqual(policyInsert.values[5], ["hybrid"]);
});

test("repository creation rejects invalid names before calling GitHub", async () => {
  const store = new PostgresAuthStore({}, { pool: {} });
  store.githubJson = async () => assert.fail("GitHub must not be called");
  await assert.rejects(
    store.createRepository("user-1", { name: "owner/repository" }),
    (error) => error.statusCode === 400,
  );
});

test("repository browser masks obvious embedded credentials and blocks secret files", async () => {
  const store = new PostgresAuthStore({}, { pool: {} });
  store.authorizeRepository = async () => ({ id: 42, full_name: "owner/repo", default_branch: "main", permissions: { pull: true, push: false, admin: false } });
  store.githubJson = async () => ({
    type: "file",
    encoding: "base64",
    name: "config.js",
    path: "src/config.js",
    size: 44,
    sha: "b".repeat(40),
    content: Buffer.from('const apiKey = "secret-value";').toString("base64"),
  });
  const result = await store.repositoryContents("user-1", "42", "src/config.js");
  assert.equal(result.file.redacted, true);
  assert.doesNotMatch(result.file.content, /secret-value/);
  await assert.rejects(
    store.repositoryContents("user-1", "42", ".env"),
    (error) => error.statusCode === 403,
  );
});

test("Harness authority intersects GitHub write rights with EHDA repository policy", async () => {
  const pool = { async query() { return { rows: [{
    repository_id: 42,
    repository_full_name: "owner/repo",
    tenant_id: "tenant-1",
    allowed_path_prefixes: ["src"],
    validation_profiles: ["tests"],
    allowed_execution_modes: ["sandbox"],
    require_write_permission: true,
  }] }; } };
  const store = new PostgresAuthStore({}, { pool });
  store.authorizeRepository = async () => ({ id: 42, full_name: "owner/repo", default_branch: "main", permissions: { pull: true, push: true, admin: false } });
  store.githubJson = async () => ({ sha: "a".repeat(40) });
  store.harnessRunners = async () => [{ ready: true, fresh: true }];
  const authority = await store.harnessAuthority("user-1", "42", "sandbox", ["patch.apply"]);
  assert.equal(authority.repository_source_id, "github:42:owner/repo");
  assert.equal(authority.base_revision, "a".repeat(40));
  assert.deepEqual(authority.allowed_path_prefixes, ["src"]);
});

test("runner pairing stores only a one-time code digest", async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) { queries.push({ sql, values }); return { rows: [] }; },
    release() {},
  };
  const store = new PostgresAuthStore({}, { pool: { async connect() { return client; } } });
  const result = await store.createHarnessRunnerPairing("user-1");
  assert.match(result.pairing_code, /^MX-[A-Za-z0-9_-]{32}$/);
  const insert = queries.find((query) => query.sql.includes("insert into public.harness_runner_pairings"));
  assert.equal(insert.values[0].length, 64);
  assert.notEqual(insert.values[0], result.pairing_code);
  assert.equal(result.expires_in_seconds, 600);
});

test("runner bootstrap stores only independent secret digests bound to a device key", async () => {
  let inserted;
  const store = new PostgresAuthStore({ publicOrigin: "https://chat.mundusx.ai" }, { pool: {
    async query(sql, values) { inserted = { sql, values }; return { rows: [] }; },
  } });
  const result = await store.createHarnessRunnerBootstrap({
    device_id: "runner-device-123",
    public_key_hex: "ab".repeat(32),
  });
  assert.match(result.session_id, /^[0-9a-f-]{36}$/);
  assert.match(result.bootstrap_secret, /^MXB-[A-Za-z0-9_-]{43}$/);
  assert.match(result.approval_url, /^https:\/\/chat\.mundusx\.ai\/runner\/connect\?/);
  assert.match(inserted.sql, /harness_runner_bootstrap_sessions/);
  assert.equal(inserted.values[1].length, 64);
  assert.equal(inserted.values[2].length, 64);
  assert.notEqual(inserted.values[1], inserted.values[2]);
  assert.doesNotMatch(JSON.stringify(inserted.values), new RegExp(result.bootstrap_secret));
});

test("runner bootstrap status confirms approval without echoing the one-use secret", async () => {
  const expires = new Date(Date.now() + 60_000);
  const store = new PostgresAuthStore({}, { pool: {
    async query() { return { rows: [{ approved_at: new Date(), consumed_at: null, expires_at: expires }] }; },
  } });
  const secret = `MXB-${"A".repeat(43)}`;
  assert.deepEqual(
    await store.harnessRunnerBootstrapStatus("123e4567-e89b-42d3-a456-426614174000", secret),
    { state: "approved" },
  );
});

test("runner inventory exposes only bounded lowercase local project slugs", async () => {
  const store = new PostgresAuthStore({}, { pool: {
    async query() {
      return { rows: [{
        runner_id: "runner-1",
        device_id: "device-1",
        execution_modes: ["hybrid"],
        supported_operations: ["file.read"],
        local_projects: ["alpha", "my-java-program", "../another-user", "Bad Name"],
        parallel_slots: 1,
        ready: true,
        trusted_identity: true,
        last_seen_epoch: Math.floor(Date.now() / 1000),
      }] };
    },
  } });
  const [runner] = await store.harnessRunners("user-1");
  assert.deepEqual(runner.local_projects, ["alpha", "my-java-program"]);
  assert.equal(runner.fresh, true);
});

test("Harness authority rejects repositories without an active EHDA policy", async () => {
  const store = new PostgresAuthStore({}, { pool: { async query() { return { rows: [] }; } } });
  store.authorizeRepository = async () => ({ id: 42, full_name: "owner/repo", default_branch: "main", permissions: { pull: true, push: true, admin: false } });
  store.githubJson = async () => [];
  await assert.rejects(
    store.harnessAuthority("user-1", "42", "sandbox", ["repository.status"]),
    (error) => error.statusCode === 403,
  );
});

test("conversation ownership is claimed once and rejects another user", async () => {
  const rows = new Map();
  const pool = {
    async query(sql, values) {
      if (sql.startsWith("insert into")) {
        if (!rows.has(values[0])) rows.set(values[0], values[1]);
        return { rowCount: 1, rows: [] };
      }
      const matches = rows.get(values[0]) === values[1];
      return { rowCount: matches ? 1 : 0, rows: matches ? [{ exists: 1 }] : [] };
    },
  };
  const store = new PostgresAuthStore({}, { pool });
  const conversation = "d0c1f854-60e7-4af3-95fe-2745621de39d";
  await store.authorizeConversation("user-a", conversation, true);
  await assert.rejects(
    store.authorizeConversation("user-b", conversation, true),
    (error) => error.statusCode === 404,
  );
});

test("MCP credentials are returned once and stored only as a digest", async () => {
  let insert;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) {
      insert = { sql, values };
      return { rows: [{ token_id: "11111111-1111-4111-8111-111111111111", name: values[2] }] };
    },
  } });

  const created = await store.createMcpToken("user-1", { name: "My Codex", expires_in_days: 30 });
  assert.match(created.token, /^mxmcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(insert.values[1].length, 64);
  assert.notEqual(insert.values[1], created.token);
  assert.equal(insert.values[2], "My Codex");
  assert.equal(insert.values[3], 30);
});

test("MCP bearer authentication resolves only an active token owner", async () => {
  const queries = [];
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes("from public.mcp_personal_access_tokens")) {
        return { rows: [{ token_id: "token-id", id: "user-1", email: "user@example.com", role: "operator" }] };
      }
      return { rows: [] };
    },
  } });

  const session = await store.mcpSession({ headers: { authorization: `Bearer mxmcp_${"a".repeat(43)}` } });
  assert.equal(session.id, "user-1");
  assert.equal(queries[0].values[0].length, 64);
  assert.equal(await store.mcpSession({ headers: { authorization: "Bearer invalid" } }), null);
});

test("MCP token revocation is scoped to the authenticated owner", async () => {
  let update;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) { update = { sql, values }; return { rowCount: 1, rows: [{ token_id: values[0] }] }; },
  } });
  const tokenId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(await store.revokeMcpToken("user-1", tokenId), { revoked: true, token_id: tokenId });
  assert.deepEqual(update.values, [tokenId, "user-1"]);
  assert.match(update.sql, /user_id = \$2::uuid/);
});

test("local agent tasks persist only supported runtime selections", async () => {
  let insert;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) {
      insert = { sql, values };
      return { rows: [{ task_id: values[0], runtime_requested: values[6], workspace_relative: values[7] }] };
    },
  } });
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const created = await store.createLocalAgentTask("22222222-2222-4222-8222-222222222222", {
    prompt: "inspect this repository", session_id: sessionId, runtime: "HERMES", workspace_relative: "my-project",
  });
  assert.equal(created.runtime_requested, "hermes");
  assert.equal(insert.values[6], "hermes");
  assert.equal(created.workspace_relative, "my-project");
  assert.equal(insert.values[7], "my-project");
  await assert.rejects(
    store.createLocalAgentTask("22222222-2222-4222-8222-222222222222", {
      prompt: "inspect", session_id: sessionId, runtime: "deepagents",
    }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    store.createLocalAgentTask("22222222-2222-4222-8222-222222222222", {
      prompt: "inspect", session_id: sessionId, workspace_relative: "../escape",
    }),
    (error) => error.statusCode === 400,
  );
});

test("local agent auto claims select Hermes only when advertised and preferred", async () => {
  const queries = [];
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) {
      queries.push({ sql, values });
      return sql.includes("with candidate")
        ? { rows: [{ runtime_requested: "auto", runtime_selected: "hermes" }] }
        : { rows: [] };
    },
  } });
  const task = await store.claimLocalAgentTask(
    "22222222-2222-4222-8222-222222222222",
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(task.runtime_selected, "hermes");
  assert.match(queries[0].sql, /capabilities->'agent_runtimes' \? 'hermes'/);
  assert.match(queries[0].sql, /capabilities->>'preferred_agent' = 'hermes'/);
});

test("project model jobs safely requeue retryable failures with the same idempotency key", async () => {
  let insert;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) {
      insert = { sql, values };
      return { rowCount: 1, rows: [{ job_id: values[0], state: "queued" }] };
    },
  } });
  const created = await store.createProjectModelJob("22222222-2222-4222-8222-222222222222", {
    project_task_id: "33333333-3333-4333-8333-333333333333",
    connection_id: "11111111-1111-4111-8111-111111111111",
    idempotency_key: "stable-model-turn-key",
  });
  assert.equal(created.state, "queued");
  assert.match(insert.sql, /on conflict \(user_id, project_task_id, idempotency_key\)/);
  assert.match(insert.sql, /error->>'retryable'/);
  assert.match(insert.sql, /then 'queued'/);
  assert.equal(insert.values[2], "stable-model-turn-key");
});
