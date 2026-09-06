import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

const SESSION_COOKIE = "__Host-mx_session";
const CSRF_COOKIE = "__Host-mx_csrf";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 10 * 60;
const RUNNER_PAIRING_SECONDS = 10 * 60;
const RUNNER_BOOTSTRAP_SECONDS = 10 * 60;
const LOCAL_AGENT_BOOTSTRAP_SECONDS = 10 * 60;
const RUNNER_BOOTSTRAP_SECRET_PATTERN = /^MXB-[A-Za-z0-9_-]{43}$/;
const RUNNER_DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const RUNNER_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64,256}$/i;
const MCP_TOKEN_PREFIX = "mxmcp_";
const MCP_TOKEN_PATTERN = /^mxmcp_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MCP_TOKEN_DAYS = 90;
const GITHUB_API_VERSION = "2026-03-10";
const MAX_GITHUB_PAGES = 5;
const MAX_GITHUB_INSTALLATIONS = 20;
const MAX_GITHUB_REPOSITORIES = 1000;
const MAX_REPOSITORY_FILE_BYTES = 256 * 1024;
const PROJECT_TEMPLATES = Object.freeze({
  "java-maven": {
    allowedPathPrefixes: ["src", "pom.xml", "README.md", ".gitignore"],
    validationProfiles: ["java-maven-test"],
    allowedExecutionModes: ["hybrid"],
  },
  generic: {
    allowedPathPrefixes: ["src", "test", "tests", "README.md", ".gitignore"],
    validationProfiles: ["repository-default"],
    allowedExecutionModes: ["sandbox", "hybrid"],
  },
});

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function googleIdTokenClaims(idToken, clientId, profile) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const issuer = String(claims?.iss || "");
    const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    const expiresAt = Number(claims?.exp || 0);
    if (!["accounts.google.com", "https://accounts.google.com"].includes(issuer) ||
        !audience.includes(clientId) || expiresAt <= Math.floor(Date.now() / 1000) ||
        String(claims?.sub || "") !== String(profile?.sub || "") ||
        normalizeEmail(claims?.email) !== normalizeEmail(profile?.email)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? [part, ""] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
  }));
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  return email;
}

function safeRedirect(value) {
  const path = String(value || "/");
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

function cookie(name, value, maxAge, httpOnly = true) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}`;
}

function encryptionKey(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch { return null; }
}

function encryptSecret(value, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value, key) {
  const [nonce, tag, encrypted] = String(value).split(".").map((part) => Buffer.from(part, "base64url"));
  if (!nonce || nonce.length !== 12 || !tag || tag.length !== 16 || !encrypted) throw new Error("Encrypted GitHub credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function githubHeaders(accessToken) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "X-GitHub-Api-Version": GITHUB_API_VERSION };
}

function sensitiveRepositoryPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
  return normalized.split("/").some((part) => part === ".git" || part === ".env" || part.startsWith(".env.") || /^(id_rsa|id_ed25519|.*\.(pem|p12|pfx|key))$/.test(part));
}

function redactRepositoryText(value) {
  let redacted = false;
  const content = String(value || "")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, () => {
      redacted = true;
      return "[REDACTED PRIVATE KEY]";
    })
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["']?)([^\s"',;]+)/gi, (_match, prefix) => {
      redacted = true;
      return `${prefix}[REDACTED]`;
    });
  return { content, redacted };
}

export function authConfigFromEnv(env = process.env) {
  return {
    required: !["0", "false", "no"].includes(String(env.MUNDUSX_CHAT_AUTH_REQUIRED ?? "true").toLowerCase()),
    databaseUrl: String(env.MUNDUSX_DATABASE_POOL_URL ?? env.DATABASE_URL ?? "").trim(),
    publicOrigin: String(env.MUNDUSX_PUBLIC_ORIGIN ?? "https://chat.mundusx.ai").replace(/\/$/, ""),
    githubClientId: String(env.MUNDUSX_GITHUB_CLIENT_ID ?? "").trim(),
    githubClientSecret: String(env.MUNDUSX_GITHUB_CLIENT_SECRET ?? "").trim(),
    googleClientId: String(env.MUNDUSX_GOOGLE_CLIENT_ID ?? "").trim(),
    googleClientSecret: String(env.MUNDUSX_GOOGLE_CLIENT_SECRET ?? "").trim(),
    encryptionKey: encryptionKey(String(env.MUNDUSX_AUTH_ENCRYPTION_KEY ?? "").trim()),
    resendApiKey: String(env.RESEND_API_KEY ?? "").trim(),
    emailFrom: String(env.MUNDUSX_AUTH_EMAIL_FROM ?? "").trim(),
  };
}

export class PostgresAuthStore {
  constructor(config, { fetchImpl = fetch, pool } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.pool = pool ?? (config.databaseUrl ? new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 }) : null);
  }

  ensureReady() {
    if (!this.pool) throw Object.assign(new Error("Authentication storage is unavailable"), { statusCode: 503 });
  }

  providers() {
    return {
      github: Boolean(this.config.githubClientId && this.config.githubClientSecret && this.config.encryptionKey),
      google: Boolean(this.config.googleClientId && this.config.googleClientSecret),
      email: Boolean(this.config.resendApiKey && this.config.emailFrom),
    };
  }

  async session(request) {
    this.ensureReady();
    const raw = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const result = await this.pool.query(`
      select s.session_hash, s.csrf_hash, u.id, u.email, u.display_name, u.role,
        exists(select 1 from public.github_user_tokens gt where gt.user_id = u.id) as github_connected
      from public.user_sessions s
      join public.users u on u.id = s.user_id
      where s.session_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'
      group by s.session_hash, s.csrf_hash, u.id, u.email, u.display_name, u.role`, [digest(raw)]);
    return result.rows[0] ?? null;
  }

  requireCsrf(request, session) {
    const cookies = parseCookies(request.headers.cookie);
    const supplied = String(request.headers["x-mundusx-csrf"] || "");
    const origin = String(request.headers.origin || "");
    if (!origin || origin !== this.config.publicOrigin || !supplied || supplied !== cookies[CSRF_COOKIE] || digest(supplied) !== session.csrf_hash) {
      throw Object.assign(new Error("CSRF validation failed"), { statusCode: 403 });
    }
  }

  async createSession(response, userId, provider, database = this.pool) {
    const raw = token();
    const csrf = token();
    await database.query(`insert into public.user_sessions
      (session_hash, csrf_hash, user_id, provider, expires_at)
      values ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
      [digest(raw), digest(csrf), userId, provider, SESSION_SECONDS]);
    response.setHeader("Set-Cookie", [cookie(SESSION_COOKIE, raw, SESSION_SECONDS), cookie(CSRF_COOKIE, csrf, SESSION_SECONDS, false)]);
  }

  async logout(request, response, session) {
    this.requireCsrf(request, session);
    await this.pool.query("update public.user_sessions set revoked_at = now() where session_hash = $1", [session.session_hash]);
    response.setHeader("Set-Cookie", [cookie(SESSION_COOKIE, "", 0), cookie(CSRF_COOKIE, "", 0, false)]);
  }

  async mcpSession(request) {
    this.ensureReady();
    const authorization = String(request.headers.authorization || "");
    const raw = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!MCP_TOKEN_PATTERN.test(raw)) return null;
    const result = await this.pool.query(`select t.token_id, u.id, u.email, u.display_name, u.role
      from public.mcp_personal_access_tokens t
      join public.users u on u.id = t.user_id
      where t.token_hash = $1 and t.revoked_at is null and t.expires_at > now() and u.status = 'active'`,
    [digest(raw)]);
    const session = result.rows[0] ?? null;
    if (session) {
      await this.pool.query(`update public.mcp_personal_access_tokens set last_used_at = now()
        where token_id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')`,
      [session.token_id]);
    }
    return session;
  }

  async createMcpToken(userId, input = {}) {
    this.ensureReady();
    const name = String(input.name || "Codex").trim();
    const expiresInDays = Number(input.expires_in_days ?? DEFAULT_MCP_TOKEN_DAYS);
    if (!name || name.length > 80) throw Object.assign(new Error("MCP token name must contain 1 to 80 characters"), { statusCode: 400 });
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      throw Object.assign(new Error("MCP token lifetime must be between 1 and 365 days"), { statusCode: 400 });
    }
    const raw = `${MCP_TOKEN_PREFIX}${token()}`;
    const result = await this.pool.query(`insert into public.mcp_personal_access_tokens
      (user_id, token_hash, name, expires_at)
      values ($1, $2, $3, now() + ($4 * interval '1 day'))
      returning token_id, name, created_at, expires_at`,
    [userId, digest(raw), name, expiresInDays]);
    return { ...result.rows[0], token: raw };
  }

  async createLocalAgentBootstrap(input = {}) {
    this.ensureReady();
    await this.pool.query(`create table if not exists public.local_agent_bootstrap_sessions (
      session_id uuid primary key,
      connector_hash text not null unique check (length(connector_hash) = 64),
      approval_hash text not null unique check (length(approval_hash) = 64),
      device_name text not null check (length(device_name) between 1 and 160),
      user_id uuid references public.users(id) on delete cascade,
      approved_at timestamptz,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )`);
    const deviceName = String(input.device_name || "MundusX developer").trim();
    if (!deviceName || deviceName.length > 160) throw Object.assign(new Error("Device name is invalid"), { statusCode: 400 });
    const sessionId = randomUUID();
    const connectorToken = `${MCP_TOKEN_PREFIX}${token()}`;
    const approvalToken = token();
    await this.pool.query(`insert into public.local_agent_bootstrap_sessions
      (session_id, connector_hash, approval_hash, device_name, expires_at)
      values ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
    [sessionId, digest(connectorToken), digest(approvalToken), deviceName, LOCAL_AGENT_BOOTSTRAP_SECONDS]);
    return {
      session_id: sessionId,
      connector_token: connectorToken,
      approval_url: `${this.config.publicOrigin}/agent/connect?session=${encodeURIComponent(sessionId)}#token=${encodeURIComponent(approvalToken)}`,
      expires_in_seconds: LOCAL_AGENT_BOOTSTRAP_SECONDS,
    };
  }

  async localAgentBootstrapApproval(sessionId, approvalToken) {
    this.ensureReady();
    const result = await this.pool.query(`select session_id, device_name, approved_at, expires_at
      from public.local_agent_bootstrap_sessions
      where session_id = $1 and approval_hash = $2 and expires_at > now()`, [sessionId, digest(approvalToken || "")]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Computer connection is invalid or expired"), { statusCode: 404 });
    return { session_id: row.session_id, device_name: row.device_name, state: row.approved_at ? "approved" : "pending", expires_at: row.expires_at };
  }

  async approveLocalAgentBootstrap(userId, sessionId, approvalToken) {
    this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(`update public.local_agent_bootstrap_sessions
        set user_id = coalesce(user_id, $3), approved_at = coalesce(approved_at, now())
        where session_id = $1 and approval_hash = $2 and expires_at > now()
          and (user_id is null or user_id = $3)
        returning connector_hash, device_name, expires_at`, [sessionId, digest(approvalToken || ""), userId]);
      const row = result.rows[0];
      if (!row) throw Object.assign(new Error("Computer connection is invalid or expired"), { statusCode: 409 });
      await client.query(`insert into public.mcp_personal_access_tokens
        (user_id, token_hash, name, expires_at) values ($1, $2, $3, now() + interval '365 days')
        on conflict (token_hash) do nothing`, [userId, row.connector_hash, `Local project · ${row.device_name}`.slice(0, 80)]);
      await client.query("commit");
      return { session_id: sessionId, device_name: row.device_name, state: "approved", expires_at: row.expires_at };
    } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async localAgentBootstrapStatus(sessionId, connectorToken) {
    this.ensureReady();
    if (!MCP_TOKEN_PATTERN.test(String(connectorToken || ""))) return { state: "expired" };
    const result = await this.pool.query(`select approved_at, expires_at from public.local_agent_bootstrap_sessions
      where session_id = $1 and connector_hash = $2`, [sessionId, digest(connectorToken)]);
    const row = result.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) return { state: "expired" };
    return { state: row.approved_at ? "approved" : "pending" };
  }

  async listMcpTokens(userId) {
    this.ensureReady();
    const result = await this.pool.query(`select token_id, name, created_at, expires_at, last_used_at
      from public.mcp_personal_access_tokens
      where user_id = $1 and revoked_at is null and expires_at > now()
      order by created_at desc limit 20`, [userId]);
    return result.rows;
  }

  async revokeMcpToken(userId, tokenId) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(tokenId || ""))) {
      throw Object.assign(new Error("MCP token id is invalid"), { statusCode: 400 });
    }
    const result = await this.pool.query(`update public.mcp_personal_access_tokens set revoked_at = now()
      where token_id = $1::uuid and user_id = $2::uuid and revoked_at is null returning token_id`,
    [tokenId, userId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("MCP token was not found"), { statusCode: 404 });
    return { revoked: true, token_id: tokenId };
  }

  async registerLocalAgent(userId, input = {}) {
    this.ensureReady();
    const connectionId = String(input.connection_id || randomUUID());
    const deviceName = String(input.device_name || "MundusX agent").trim();
    if (!UUID_PATTERN.test(connectionId) || !deviceName || deviceName.length > 160) {
      throw Object.assign(new Error("Local agent identity is invalid"), { statusCode: 400 });
    }
    const capabilities = input.capabilities && typeof input.capabilities === "object"
      ? input.capabilities
      : {};
    const result = await this.pool.query(`insert into public.local_agent_connections
      (connection_id, user_id, device_name, capabilities, last_seen_at)
      values ($1::uuid, $2::uuid, $3, $4::jsonb, now())
      on conflict (connection_id) do update set
        device_name = excluded.device_name,
        capabilities = excluded.capabilities,
        last_seen_at = now(),
        revoked_at = null
      where public.local_agent_connections.user_id = excluded.user_id
      returning connection_id, device_name, capabilities, last_seen_at`,
    [connectionId, userId, deviceName, JSON.stringify(capabilities)]);
    if (result.rowCount !== 1) {
      throw Object.assign(new Error("Local agent connection belongs to another user"), { statusCode: 403 });
    }
    return result.rows[0];
  }

  async localAgentStatus(userId) {
    this.ensureReady();
    const result = await this.pool.query(`select connection_id, device_name, capabilities, last_seen_at,
      last_seen_at > now() - interval '45 seconds' as online
      from public.local_agent_connections
      where user_id = $1::uuid and revoked_at is null
      order by last_seen_at desc limit 10`, [userId]);
    return { online: result.rows.some((row) => row.online), connections: result.rows };
  }

  async createLocalAgentTask(userId, input = {}) {
    this.ensureReady();
    const prompt = String(input.prompt || input.message || "").trim();
    const conversationId = input.conversation_id || input.conversationId || null;
    const sessionId = String(input.session_id || randomUUID());
    const runtimeRequested = String(input.runtime || "auto").trim().toLowerCase();
    const workspaceRelative = input.workspace_relative == null
      ? null
      : String(input.workspace_relative).trim().toLowerCase();
    if (!prompt || prompt.length > 16000 || !UUID_PATTERN.test(sessionId)) {
      throw Object.assign(new Error("Local agent task is invalid"), { statusCode: 400 });
    }
    if (conversationId && !UUID_PATTERN.test(String(conversationId))) {
      throw Object.assign(new Error("conversation_id must be a UUID"), { statusCode: 400 });
    }
    if (!["auto", "native", "hermes"].includes(runtimeRequested)) {
      throw Object.assign(new Error("runtime must be auto, native, or hermes"), { statusCode: 400 });
    }
    if (workspaceRelative && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspaceRelative)) {
      throw Object.assign(new Error("workspace_relative must be a project slug"), { statusCode: 400 });
    }
    const taskId = randomUUID();
    const result = await this.pool.query(`insert into public.local_agent_tasks
      (task_id, user_id, conversation_id, session_id, prompt, allow_mutations, runtime_requested, workspace_relative)
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8)
      returning task_id, conversation_id, session_id, runtime_requested, workspace_relative, state, created_at`,
    [taskId, userId, conversationId, sessionId, prompt, input.allow_mutations === true, runtimeRequested, workspaceRelative]);
    return result.rows[0];
  }

  async claimLocalAgentTask(userId, connectionId) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(connectionId || ""))) {
      throw Object.assign(new Error("connection_id must be a UUID"), { statusCode: 400 });
    }
    const result = await this.pool.query(`with candidate as (
      select task_id from public.local_agent_tasks
      where user_id = $1::uuid
        and exists (select 1 from public.local_agent_connections connection
          where connection.connection_id = $2::uuid and connection.user_id = $1::uuid
            and connection.revoked_at is null)
        and (
        state = 'queued' or (state = 'running' and lease_expires_at < now())
      )
        and (runtime_requested <> 'hermes' or exists (
          select 1 from public.local_agent_connections runtime_connection
          where runtime_connection.connection_id = $2::uuid
            and runtime_connection.capabilities->'agent_runtimes' ? 'hermes'
        ))
      order by created_at for update skip locked limit 1
    )
    update public.local_agent_tasks task set
      state = 'running', connection_id = $2::uuid,
      runtime_selected = case
        when task.runtime_requested = 'hermes' then 'hermes'
        when task.runtime_requested = 'auto' and exists (
          select 1 from public.local_agent_connections runtime_connection
          where runtime_connection.connection_id = $2::uuid
            and runtime_connection.capabilities->'agent_runtimes' ? 'hermes'
            and runtime_connection.capabilities->>'preferred_agent' = 'hermes'
        ) then 'hermes'
        else 'native'
      end,
      started_at = coalesce(started_at, now()), lease_expires_at = now() + interval '60 seconds'
    from candidate where task.task_id = candidate.task_id
    returning task.task_id, task.conversation_id, task.session_id, task.prompt,
      task.allow_mutations, task.runtime_requested, task.runtime_selected,
      task.workspace_relative, task.state`, [userId, connectionId]);
    await this.pool.query(`update public.local_agent_connections set last_seen_at = now()
      where connection_id = $1::uuid and user_id = $2::uuid and revoked_at is null`,
    [connectionId, userId]);
    return result.rows[0] ?? null;
  }

  async heartbeatLocalAgentTask(userId, connectionId, taskId) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(connectionId || "")) || !UUID_PATTERN.test(String(taskId || ""))) {
      throw Object.assign(new Error("Local agent task identity is invalid"), { statusCode: 400 });
    }
    const result = await this.pool.query(`update public.local_agent_tasks task set
      lease_expires_at = case when task.state = 'running' then now() + interval '60 seconds' else null end
      where task.task_id = $1::uuid and task.user_id = $2::uuid and task.connection_id = $3::uuid
        and exists (select 1 from public.local_agent_connections connection
          where connection.connection_id = $3::uuid and connection.user_id = $2::uuid
            and connection.revoked_at is null)
      returning task.task_id, task.session_id, task.state`, [taskId, userId, connectionId]);
    await this.pool.query(`update public.local_agent_connections set last_seen_at = now()
      where connection_id = $1::uuid and user_id = $2::uuid and revoked_at is null`,
    [connectionId, userId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Local agent task was not found"), { statusCode: 404 });
    return result.rows[0];
  }

  async appendLocalAgentEvents(userId, taskId, events = []) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(taskId || "")) || !Array.isArray(events) || events.length > 200) {
      throw Object.assign(new Error("Local agent events are invalid"), { statusCode: 400 });
    }
    for (const item of events) {
      const sequence = Number(item?.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || !item?.event || typeof item.event !== "object") {
        throw Object.assign(new Error("Local agent event is invalid"), { statusCode: 400 });
      }
      await this.pool.query(`insert into public.local_agent_task_events (task_id, sequence, event)
        select task_id, $3, $4::jsonb from public.local_agent_tasks
        where task_id = $1::uuid and user_id = $2::uuid
        on conflict (task_id, sequence) do nothing`,
      [taskId, userId, sequence, JSON.stringify(item.event)]);
    }
    return { accepted: events.length };
  }

  async completeLocalAgentTask(userId, taskId, input = {}) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(taskId || ""))) {
      throw Object.assign(new Error("task_id must be a UUID"), { statusCode: 400 });
    }
    const success = input.status !== "failed" && !input.error;
    const result = await this.pool.query(`update public.local_agent_tasks set
      state = $3, result = $4::jsonb, error = $5, completed_at = now(), lease_expires_at = null
      where task_id = $1::uuid and user_id = $2::uuid and state = 'running'
      returning task_id, conversation_id, session_id, state, result, error, completed_at`,
    [taskId, userId, success ? "completed" : "failed", JSON.stringify(input.result ?? null), input.error ? String(input.error).slice(0, 4000) : null]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Local agent task is not running"), { statusCode: 409 });
    return result.rows[0];
  }

  async localAgentTask(userId, taskId) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(taskId || ""))) {
      throw Object.assign(new Error("task_id must be a UUID"), { statusCode: 400 });
    }
    const result = await this.pool.query(`select task_id, conversation_id, session_id, state,
      runtime_requested, runtime_selected, workspace_relative, result, error,
      created_at, started_at, completed_at, cancelled_at
      from public.local_agent_tasks where task_id = $1::uuid and user_id = $2::uuid`,
    [taskId, userId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Local agent task was not found"), { statusCode: 404 });
    const events = await this.pool.query(`select sequence, event, created_at
      from public.local_agent_task_events where task_id = $1::uuid order by sequence limit 500`, [taskId]);
    return { ...result.rows[0], events: events.rows };
  }

  async cancelLocalAgentTask(userId, taskId) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(taskId || ""))) {
      throw Object.assign(new Error("task_id must be a UUID"), { statusCode: 400 });
    }
    const result = await this.pool.query(`update public.local_agent_tasks set
      state = 'cancelled', cancelled_at = now(), lease_expires_at = null
      where task_id = $1::uuid and user_id = $2::uuid and state in ('queued', 'running')
      returning task_id, session_id, state`, [taskId, userId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Local agent task cannot be cancelled"), { statusCode: 409 });
    return result.rows[0];
  }

  async createProjectModelJob(userId, input) {
    this.ensureReady();
    const taskId = String(input.project_task_id || "");
    const connectionId = String(input.connection_id || "");
    const key = String(input.idempotency_key || "");
    if (!UUID_PATTERN.test(taskId) || !UUID_PATTERN.test(connectionId) || key.length < 16 || key.length > 128) {
      throw Object.assign(new Error("Project model job identity is invalid"), { statusCode: 400 });
    }
    const jobId = randomUUID();
    const result = await this.pool.query(`insert into public.project_model_jobs
      (job_id, user_id, project_task_id, idempotency_key, request)
      select $1::uuid, $2::uuid, task_id, $3, $4::jsonb from public.local_agent_tasks
      where task_id = $5::uuid and user_id = $2::uuid and connection_id = $6::uuid and state = 'running'
      on conflict (user_id, project_task_id, idempotency_key) do update set
        state = case
          when public.project_model_jobs.state in ('failed', 'expired')
            and coalesce((public.project_model_jobs.error->>'retryable')::boolean, false)
          then 'queued'
          else public.project_model_jobs.state
        end,
        started_at = case
          when public.project_model_jobs.state in ('failed', 'expired')
            and coalesce((public.project_model_jobs.error->>'retryable')::boolean, false)
          then null
          else public.project_model_jobs.started_at
        end,
        completed_at = case
          when public.project_model_jobs.state in ('failed', 'expired')
            and coalesce((public.project_model_jobs.error->>'retryable')::boolean, false)
          then null
          else public.project_model_jobs.completed_at
        end,
        result = case
          when public.project_model_jobs.state in ('failed', 'expired')
            and coalesce((public.project_model_jobs.error->>'retryable')::boolean, false)
          then null
          else public.project_model_jobs.result
        end,
        error = case
          when public.project_model_jobs.state in ('failed', 'expired')
            and coalesce((public.project_model_jobs.error->>'retryable')::boolean, false)
          then null
          else public.project_model_jobs.error
        end,
        expires_at = case
          when public.project_model_jobs.state in ('failed', 'expired')
            and coalesce((public.project_model_jobs.error->>'retryable')::boolean, false)
          then now() + interval '10 minutes'
          else public.project_model_jobs.expires_at
        end
      returning job_id, project_task_id, state, created_at, expires_at`,
    [jobId, userId, key, JSON.stringify(input), taskId, connectionId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Running project task was not found"), { statusCode: 404 });
    return result.rows[0];
  }

  async startProjectModelJob(userId, jobId) {
    const result = await this.pool.query(`update public.project_model_jobs set state='running', started_at=now()
      where job_id=$1::uuid and user_id=$2::uuid and state='queued' returning request`, [jobId, userId]);
    return result.rows[0]?.request ?? null;
  }

  async finishProjectModelJob(userId, jobId, result, error = null) {
    const state = error ? "failed" : "completed";
    await this.pool.query(`update public.project_model_jobs set state=$3, result=$4::jsonb, error=$5::jsonb, completed_at=now()
      where job_id=$1::uuid and user_id=$2::uuid and state='running'`,
    [jobId, userId, state, JSON.stringify(result ?? null), JSON.stringify(error)]);
  }

  async projectModelJob(userId, jobId) {
    if (!UUID_PATTERN.test(String(jobId))) throw Object.assign(new Error("Model job was not found"), { statusCode: 404 });
    await this.pool.query(`update public.project_model_jobs set state='expired'
      where job_id=$1::uuid and user_id=$2::uuid and state in ('queued','running') and expires_at <= now()`, [jobId, userId]);
    const result = await this.pool.query(`select job_id, project_task_id, state, result, error, created_at, started_at, completed_at, expires_at
      from public.project_model_jobs where job_id=$1::uuid and user_id=$2::uuid`, [jobId, userId]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Model job was not found"), { statusCode: 404 });
    return row;
  }

  async cancelProjectModelJob(userId, jobId) {
    const result = await this.pool.query(`update public.project_model_jobs set state='cancelled', completed_at=now()
      where job_id=$1::uuid and user_id=$2::uuid and state in ('queued','running') returning job_id, state`, [jobId, userId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Model job cannot be cancelled"), { statusCode: 409 });
    return result.rows[0];
  }

  async authorizeConversation(userId, conversationId, create = false) {
    if (!conversationId) throw Object.assign(new Error("conversation id is required"), { statusCode: 400 });
    try {
      if (create) {
        await this.pool.query("insert into public.user_chat_conversations (conversation_id, user_id) values ($1::uuid, $2::uuid) on conflict (conversation_id) do nothing", [conversationId, userId]);
      }
      const found = await this.pool.query("select 1 from public.user_chat_conversations where conversation_id = $1::uuid and user_id = $2::uuid", [conversationId, userId]);
      if (found.rowCount !== 1) throw Object.assign(new Error("Conversation is not available to this user"), { statusCode: 404 });
    } catch (error) {
      if (error.code === "22P02") throw Object.assign(new Error("conversation id must be a UUID"), { statusCode: 400 });
      throw error;
    }
  }

  async storeGithubToken(database, userId, payload) {
    if (!this.config.encryptionKey) throw Object.assign(new Error("GitHub credential encryption is unavailable"), { statusCode: 503 });
    const accessExpiresAt = Number(payload.expires_in) > 0 ? new Date(Date.now() + Number(payload.expires_in) * 1000) : null;
    const refreshExpiresAt = Number(payload.refresh_token_expires_in) > 0 ? new Date(Date.now() + Number(payload.refresh_token_expires_in) * 1000) : null;
    await database.query(`insert into public.github_user_tokens
      (user_id, access_ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, token_type)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id) do update set
        access_ciphertext = excluded.access_ciphertext,
        refresh_ciphertext = coalesce(excluded.refresh_ciphertext, public.github_user_tokens.refresh_ciphertext),
        access_expires_at = excluded.access_expires_at,
        refresh_expires_at = coalesce(excluded.refresh_expires_at, public.github_user_tokens.refresh_expires_at),
        token_type = excluded.token_type,
        updated_at = now()`, [
      userId,
      encryptSecret(payload.access_token, this.config.encryptionKey),
      payload.refresh_token ? encryptSecret(payload.refresh_token, this.config.encryptionKey) : null,
      accessExpiresAt,
      refreshExpiresAt,
      String(payload.token_type || "bearer").toLowerCase(),
    ]);
  }

  async githubToken(userId) {
    this.ensureReady();
    if (!this.providers().github) throw Object.assign(new Error("GitHub App access is unavailable"), { statusCode: 503 });
    const result = await this.pool.query("select * from public.github_user_tokens where user_id = $1", [userId]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Connect GitHub to access repositories"), { statusCode: 403 });
    const expiresAt = row.access_expires_at ? new Date(row.access_expires_at).getTime() : null;
    if (!expiresAt || expiresAt > Date.now() + 5 * 60 * 1000) return decryptSecret(row.access_ciphertext, this.config.encryptionKey);
    if (!row.refresh_ciphertext || (row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() <= Date.now())) {
      await this.pool.query("delete from public.github_user_tokens where user_id = $1", [userId]);
      throw Object.assign(new Error("GitHub access expired; reconnect your account"), { statusCode: 401 });
    }
    const refreshed = await this.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        grant_type: "refresh_token",
        refresh_token: decryptSecret(row.refresh_ciphertext, this.config.encryptionKey),
      }),
    });
    const payload = await refreshed.json();
    if (!refreshed.ok || !payload.access_token) throw Object.assign(new Error("GitHub access could not be refreshed"), { statusCode: 502 });
    await this.storeGithubToken(this.pool, userId, payload);
    return payload.access_token;
  }

  async githubJson(userId, url, { method = "GET", body } = {}) {
    const accessToken = await this.githubToken(userId);
    const response = await this.fetch(url, {
      method,
      headers: { ...githubHeaders(accessToken), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw Object.assign(new Error("GitHub access expired; reconnect your account"), { statusCode: 401 });
    if (response.status === 403) throw Object.assign(new Error("GitHub denied this repository operation"), { statusCode: 403 });
    if (response.status === 404) throw Object.assign(new Error("Repository resource was not found"), { statusCode: 404 });
    if (response.status === 422) throw Object.assign(new Error(String(payload.message || "Repository name or settings were rejected by GitHub")), { statusCode: 422 });
    if (!response.ok) throw Object.assign(new Error(`GitHub returned ${response.status}`), { statusCode: 502 });
    return payload;
  }

  async createRepository(userId, input = {}) {
    const name = String(input.name || "").trim();
    const description = String(input.description || "").trim();
    const visibility = String(input.visibility || "private").toLowerCase();
    const template = String(input.template || "java-maven").toLowerCase();
    if (!/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(name)) {
      throw Object.assign(new Error("Repository name must use 1-100 letters, numbers, dots, dashes, or underscores"), { statusCode: 400 });
    }
    if (description.length > 350) throw Object.assign(new Error("Repository description is too long"), { statusCode: 400 });
    if (!["private", "public"].includes(visibility)) throw Object.assign(new Error("Repository visibility must be private or public"), { statusCode: 400 });
    const projectPolicy = PROJECT_TEMPLATES[template];
    if (!projectPolicy) throw Object.assign(new Error("Project template is not supported"), { statusCode: 400 });

    const created = await this.githubJson(userId, "https://api.github.com/user/repos", {
      method: "POST",
      body: {
        name,
        description,
        private: visibility === "private",
        auto_init: true,
      },
    });
    const repo = this.normalizeRepository(created);
    if (!repo.id || !repo.full_name || !created.owner?.login) {
      throw Object.assign(new Error("GitHub did not return the created user repository"), { statusCode: 502 });
    }
    await this.pool.query(`with stale_policy as (
      delete from public.repository_harness_policies
      where repository_id <> $1 and lower(repository_full_name) = lower($2)
    )
      insert into public.repository_harness_policies
      (repository_id, repository_full_name, tenant_id, allowed_path_prefixes,
       validation_profiles, allowed_execution_modes, require_write_permission, created_by)
      values ($1, $2, $3, $4, $5, $6, true, $7)
      on conflict (repository_id) do update set
        repository_full_name = excluded.repository_full_name,
        tenant_id = excluded.tenant_id,
        allowed_path_prefixes = excluded.allowed_path_prefixes,
        validation_profiles = excluded.validation_profiles,
        allowed_execution_modes = excluded.allowed_execution_modes,
        require_write_permission = true,
        status = 'active',
        updated_at = now()`, [
      repo.id,
      repo.full_name,
      `user:${userId}`,
      projectPolicy.allowedPathPrefixes,
      projectPolicy.validationProfiles,
      projectPolicy.allowedExecutionModes,
      `chat-user:${userId}`,
    ]);
    return { repository: repo, template };
  }

  async repositories(userId) {
    const installations = [];
    for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
      const payload = await this.githubJson(userId, `https://api.github.com/user/installations?per_page=100&page=${page}`);
      const batch = Array.isArray(payload.installations) ? payload.installations : [];
      installations.push(...batch);
      if (batch.length < 100) break;
    }
    const repositories = [];
    for (const installation of installations.slice(0, MAX_GITHUB_INSTALLATIONS)) {
      for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
        const payload = await this.githubJson(userId, `https://api.github.com/user/installations/${encodeURIComponent(installation.id)}/repositories?per_page=100&page=${page}`);
        const batch = Array.isArray(payload.repositories) ? payload.repositories : [];
        repositories.push(...batch.map((repo) => this.normalizeRepository(repo, installation.id)));
        if (repositories.length >= MAX_GITHUB_REPOSITORIES) return repositories.slice(0, MAX_GITHUB_REPOSITORIES).sort((left, right) => left.full_name.localeCompare(right.full_name));
        if (batch.length < 100) break;
      }
    }
    return repositories.sort((left, right) => left.full_name.localeCompare(right.full_name));
  }

  normalizeRepository(repo, installationId = null) {
    return {
      id: Number(repo.id),
      installation_id: installationId,
      full_name: String(repo.full_name || ""),
      private: Boolean(repo.private),
      default_branch: String(repo.default_branch || "main"),
      permissions: {
        pull: Boolean(repo.permissions?.pull || repo.permissions?.triage || repo.permissions?.push || repo.permissions?.maintain || repo.permissions?.admin),
        push: Boolean(repo.permissions?.push || repo.permissions?.maintain || repo.permissions?.admin),
        admin: Boolean(repo.permissions?.admin),
      },
    };
  }

  async authorizeRepository(userId, repositoryId, { requirePush = false } = {}) {
    if (!/^\d+$/.test(String(repositoryId || ""))) throw Object.assign(new Error("repository id is invalid"), { statusCode: 400 });
    const repo = this.normalizeRepository(await this.githubJson(userId, `https://api.github.com/repositories/${repositoryId}`));
    if (!repo.id || !repo.full_name || !repo.permissions.pull || (requirePush && !repo.permissions.push)) {
      throw Object.assign(new Error(requirePush ? "Write access to this repository is required" : "Repository access is required"), { statusCode: 403 });
    }
    return repo;
  }

  async repositoryContents(userId, repositoryId, path = "", ref = "") {
    const repo = await this.authorizeRepository(userId, repositoryId);
    const normalizedPath = String(path || "").replace(/^\/+|\/+$/g, "");
    if (normalizedPath.includes("..") || sensitiveRepositoryPath(normalizedPath)) throw Object.assign(new Error("Repository path is not available"), { statusCode: 403 });
    const selectedRef = String(ref || repo.default_branch);
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(selectedRef) || selectedRef.includes("..")) throw Object.assign(new Error("repository ref is invalid"), { statusCode: 400 });
    const encodedPath = normalizedPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const payload = await this.githubJson(userId, `https://api.github.com/repos/${repo.full_name}/contents/${encodedPath}?ref=${encodeURIComponent(selectedRef)}`);
    if (Array.isArray(payload)) {
      return { repository: repo, ref: selectedRef, path: normalizedPath, entries: payload.slice(0, 500).filter((entry) => !sensitiveRepositoryPath(entry.path)).map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, size: entry.size, sha: entry.sha })) };
    }
    if (payload.type !== "file" || payload.encoding !== "base64" || Number(payload.size) > MAX_REPOSITORY_FILE_BYTES) throw Object.assign(new Error("Only bounded text files can be viewed"), { statusCode: 413 });
    const content = Buffer.from(String(payload.content || "").replace(/\s/g, ""), "base64").toString("utf8");
    if (content.includes("\0")) throw Object.assign(new Error("Binary files cannot be viewed"), { statusCode: 415 });
    const safeText = redactRepositoryText(content);
    return { repository: repo, ref: selectedRef, path: normalizedPath, file: { name: payload.name, path: payload.path, size: payload.size, sha: payload.sha, ...safeText } };
  }

  async harnessAuthority(userId, repositoryId, executionMode, operations = []) {
    if (!Array.isArray(operations)) throw Object.assign(new Error("allowed operations must be a list"), { statusCode: 400 });
    const requirePush = operations.some((operation) => ["patch.apply", "validation.run"].includes(String(operation)));
    const repo = await this.authorizeRepository(userId, repositoryId, { requirePush });
    let policyResult = await this.pool.query(`select * from public.repository_harness_policies
      where repository_id = $1 and status = 'active'`, [repo.id]);
    if (!policyResult.rows[0]) {
      const root = await this.githubJson(userId, `https://api.github.com/repos/${repo.full_name}/contents/?ref=${encodeURIComponent(repo.default_branch)}`);
      const allowedPathPrefixes = Array.isArray(root)
        ? root.filter((entry) => ["dir", "file"].includes(entry.type) && !sensitiveRepositoryPath(entry.path)).slice(0, 200).map((entry) => entry.path)
        : [];
      if (!allowedPathPrefixes.length) throw Object.assign(new Error("Repository has no safe paths available for Harness work"), { statusCode: 403 });
      await this.pool.query(`insert into public.repository_harness_policies
        (repository_id, repository_full_name, tenant_id, allowed_path_prefixes,
         validation_profiles, allowed_execution_modes, require_write_permission, created_by)
        values ($1, $2, $3, $4, $5, $6, true, $7)
        on conflict (repository_id) do nothing`, [
        repo.id,
        repo.full_name,
        `user:${userId}`,
        allowedPathPrefixes,
        ["repository-default"],
        ["sandbox", "hybrid"],
        `chat-user:${userId}`,
      ]);
      policyResult = await this.pool.query(`select * from public.repository_harness_policies
        where repository_id = $1 and status = 'active'`, [repo.id]);
    }
    const policy = policyResult.rows[0];
    if (!policy || policy.repository_full_name.toLowerCase() !== repo.full_name.toLowerCase()) throw Object.assign(new Error("This repository is not enabled for EHDA Harness work"), { statusCode: 403 });
    if (!policy.allowed_execution_modes.includes(executionMode)) throw Object.assign(new Error("EHDA policy does not permit this execution mode"), { statusCode: 403 });
    if (policy.require_write_permission && !repo.permissions.push) throw Object.assign(new Error("Write permission is required by EHDA policy"), { statusCode: 403 });
    const commit = await this.githubJson(userId, `https://api.github.com/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`);
    if (!/^[0-9a-f]{40}$/i.test(String(commit.sha || ""))) throw Object.assign(new Error("GitHub did not return an immutable base revision"), { statusCode: 502 });
    const authority = {
      user_id: userId,
      tenant_id: policy.tenant_id,
      repository_source_id: `github:${repo.id}:${repo.full_name}`,
      base_revision: String(commit.sha).toLowerCase(),
      allowed_path_prefixes: policy.allowed_path_prefixes,
      validation_profiles: policy.validation_profiles,
      allowed_execution_modes: policy.allowed_execution_modes,
    };
    const runners = await this.harnessRunners(userId);
    if (!runners.some((runner) => runner.ready && runner.fresh)) {
      throw Object.assign(new Error("Pair and start your Harness runner before submitting repository work"), { statusCode: 409 });
    }
    return authority;
  }

  async createHarnessRunnerPairing(userId) {
    this.ensureReady();
    const pairingCode = `MX-${token(24)}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "delete from public.harness_runner_pairings where user_id = $1 and consumed_at is null",
        [userId],
      );
      await client.query(`insert into public.harness_runner_pairings
        (pairing_hash, user_id, expires_at)
        values ($1, $2, now() + ($3 * interval '1 second'))`,
        [digest(pairingCode), userId, RUNNER_PAIRING_SECONDS],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      pairing_code: pairingCode,
      expires_in_seconds: RUNNER_PAIRING_SECONDS,
    };
  }

  async createHarnessRunnerBootstrap(input = {}) {
    this.ensureReady();
    const deviceId = String(input.device_id || "").trim();
    const publicKeyHex = String(input.public_key_hex || "").trim().toLowerCase();
    if (!RUNNER_DEVICE_ID_PATTERN.test(deviceId)) {
      throw Object.assign(new Error("Runner device id is invalid"), { statusCode: 400 });
    }
    if (!RUNNER_PUBLIC_KEY_PATTERN.test(publicKeyHex)) {
      throw Object.assign(new Error("Runner public key is invalid"), { statusCode: 400 });
    }
    const sessionId = randomUUID();
    const bootstrapSecret = `MXB-${token()}`;
    const approvalToken = token();
    await this.pool.query(`with cleared as (
      delete from public.harness_runner_bootstrap_sessions
      where expires_at <= now()
         or (device_id = $4 and public_key_hex = $5 and consumed_at is null)
    )
      insert into public.harness_runner_bootstrap_sessions
      (session_id, bootstrap_hash, approval_hash, device_id, public_key_hex, expires_at)
      values ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))`, [
      sessionId,
      digest(bootstrapSecret),
      digest(approvalToken),
      deviceId,
      publicKeyHex,
      RUNNER_BOOTSTRAP_SECONDS,
    ]);
    return {
      session_id: sessionId,
      bootstrap_secret: bootstrapSecret,
      approval_url: `${this.config.publicOrigin}/runner/connect?session=${encodeURIComponent(sessionId)}#token=${encodeURIComponent(approvalToken)}`,
      expires_in_seconds: RUNNER_BOOTSTRAP_SECONDS,
    };
  }

  async harnessRunnerBootstrapApproval(sessionId, approvalToken) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(sessionId)) || !approvalToken) {
      throw Object.assign(new Error("Runner connection is invalid or expired"), { statusCode: 404 });
    }
    const result = await this.pool.query(`select session_id, device_id, approved_at, consumed_at, expires_at
      from public.harness_runner_bootstrap_sessions
      where session_id = $1 and approval_hash = $2 and expires_at > now()`, [sessionId, digest(approvalToken)]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Runner connection is invalid or expired"), { statusCode: 404 });
    return {
      session_id: row.session_id,
      device_id: row.device_id,
      state: row.consumed_at ? "connected" : row.approved_at ? "approved" : "pending",
      expires_at: row.expires_at,
    };
  }

  async approveHarnessRunnerBootstrap(userId, sessionId, approvalToken) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(sessionId)) || !approvalToken) {
      throw Object.assign(new Error("Runner connection is invalid or expired"), { statusCode: 404 });
    }
    const result = await this.pool.query(`update public.harness_runner_bootstrap_sessions
      set user_id = coalesce(user_id, $3), approved_at = coalesce(approved_at, now())
      where session_id = $1 and approval_hash = $2 and expires_at > now() and consumed_at is null
        and (user_id is null or user_id = $3)
      returning session_id, device_id, approved_at, expires_at`, [sessionId, digest(approvalToken), userId]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Runner connection is invalid, expired, or already used"), { statusCode: 409 });
    return { session_id: row.session_id, device_id: row.device_id, state: "approved", expires_at: row.expires_at };
  }

  async harnessRunnerBootstrapStatus(sessionId, bootstrapSecret) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(sessionId)) || !RUNNER_BOOTSTRAP_SECRET_PATTERN.test(String(bootstrapSecret))) {
      throw Object.assign(new Error("Runner connection is invalid or expired"), { statusCode: 404 });
    }
    const result = await this.pool.query(`select approved_at, consumed_at, expires_at
      from public.harness_runner_bootstrap_sessions
      where session_id = $1 and bootstrap_hash = $2`, [sessionId, digest(bootstrapSecret)]);
    const row = result.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) return { state: "expired" };
    if (row.consumed_at) return { state: "connected" };
    if (row.approved_at) return { state: "approved" };
    return { state: "pending" };
  }

  async harnessRunners(userId) {
    this.ensureReady();
    const result = await this.pool.query(`select runner_id, device_id, execution_modes,
      supported_operations, local_projects, parallel_slots, ready, trusted_identity, last_seen_epoch
      from public.harness_runners
      where owner_user_id = $1
      order by last_seen_epoch desc
      limit 20`, [userId]);
    const nowEpoch = Math.floor(Date.now() / 1000);
    return result.rows.map((runner) => ({
      runner_id: runner.runner_id,
      device_id: runner.device_id,
      execution_modes: Array.isArray(runner.execution_modes) ? runner.execution_modes : [],
      supported_operations: Array.isArray(runner.supported_operations) ? runner.supported_operations : [],
      local_projects: Array.isArray(runner.local_projects)
        ? runner.local_projects.filter((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)).slice(0, 100)
        : [],
      parallel_slots: Number(runner.parallel_slots),
      ready: Boolean(runner.ready),
      trusted_identity: Boolean(runner.trusted_identity),
      last_seen_epoch: Number(runner.last_seen_epoch),
      fresh: nowEpoch - Number(runner.last_seen_epoch) <= 60,
    }));
  }

  async startGithub(redirectPath = "/") {
    this.ensureReady();
    if (!this.providers().github) throw Object.assign(new Error("GitHub login is unavailable"), { statusCode: 503 });
    const state = token();
    const verifier = token(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await this.pool.query(`insert into public.auth_challenges
      (challenge_hash, challenge_type, code_verifier, redirect_path, expires_at)
      values ($1, 'github_oauth', $2, $3, now() + ($4 * interval '1 second'))`,
      [digest(state), verifier, safeRedirect(redirectPath), CHALLENGE_SECONDS]);
    const params = new URLSearchParams({ client_id: this.config.githubClientId, redirect_uri: `${this.config.publicOrigin}/api/auth/github/callback`, scope: "read:user user:email", state, code_challenge: challenge, code_challenge_method: "S256" });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async finishGithub(query, response) {
    this.ensureReady();
    const state = String(query.get("state") || "");
    const code = String(query.get("code") || "");
    const found = await this.pool.query(`update public.auth_challenges set consumed_at = now()
      where challenge_hash = $1 and challenge_type = 'github_oauth' and consumed_at is null and expires_at > now()
      returning code_verifier, redirect_path`, [digest(state)]);
    if (!code || found.rowCount !== 1) throw Object.assign(new Error("Invalid or expired GitHub login"), { statusCode: 400 });
    const exchange = await this.fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: this.config.githubClientId, client_secret: this.config.githubClientSecret, code, redirect_uri: `${this.config.publicOrigin}/api/auth/github/callback`, code_verifier: found.rows[0].code_verifier }) });
    const exchanged = await exchange.json();
    if (!exchange.ok || !exchanged.access_token) throw Object.assign(new Error("GitHub login verification failed"), { statusCode: 502 });
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${exchanged.access_token}`, "X-GitHub-Api-Version": "2022-11-28" };
    const [profileResponse, emailsResponse] = await Promise.all([this.fetch("https://api.github.com/user", { headers }), this.fetch("https://api.github.com/user/emails", { headers })]);
    const profile = await profileResponse.json();
    const emails = await emailsResponse.json();
    const verified = Array.isArray(emails) ? (emails.find((item) => item.verified && item.primary) ?? emails.find((item) => item.verified)) : null;
    const email = normalizeEmail(verified?.email);
    if (!profileResponse.ok || !emailsResponse.ok || !profile?.id || !email) throw Object.assign(new Error("GitHub account needs a verified email"), { statusCode: 403 });
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const userId = await this.upsertIdentity(client, { provider: "github", subject: String(profile.id), login: profile.login, email, displayName: profile.name || profile.login, profile: { avatar_url: profile.avatar_url } });
      await this.storeGithubToken(client, userId, exchanged);
      await client.query("commit");
      await this.createSession(response, userId, "github", client);
      return safeRedirect(found.rows[0].redirect_path);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async startGoogle(redirectPath = "/") {
    this.ensureReady();
    if (!this.providers().google) throw Object.assign(new Error("Google login is unavailable"), { statusCode: 503 });
    const state = token();
    const verifier = token(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await this.pool.query(`insert into public.auth_challenges
      (challenge_hash, challenge_type, code_verifier, redirect_path, expires_at)
      values ($1, 'google_oauth', $2, $3, now() + ($4 * interval '1 second'))`,
    [digest(state), verifier, safeRedirect(redirectPath), CHALLENGE_SECONDS]);
    const params = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: `${this.config.publicOrigin}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async finishGoogle(query, response) {
    this.ensureReady();
    const state = String(query.get("state") || "");
    const code = String(query.get("code") || "");
    const found = await this.pool.query(`update public.auth_challenges set consumed_at = now()
      where challenge_hash = $1 and challenge_type = 'google_oauth' and consumed_at is null and expires_at > now()
      returning code_verifier, redirect_path`, [digest(state)]);
    if (!code || found.rowCount !== 1) throw Object.assign(new Error("Invalid or expired Google login"), { statusCode: 400 });
    const tokenResponse = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        code,
        code_verifier: found.rows[0].code_verifier,
        grant_type: "authorization_code",
        redirect_uri: `${this.config.publicOrigin}/api/auth/google/callback`,
      }),
    });
    const exchanged = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !exchanged.access_token) throw Object.assign(new Error("Google login verification failed"), { statusCode: 502 });
    const profileResponse = await this.fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${exchanged.access_token}`, Accept: "application/json" },
    });
    const profile = await profileResponse.json().catch(() => ({}));
    const email = normalizeEmail(profile.email);
    const idTokenClaims = googleIdTokenClaims(exchanged.id_token, this.config.googleClientId, profile);
    const emailVerified = profile.email_verified === true
      || profile.email_verified === "true"
      || profile.verified_email === true
      || profile.verified_email === "true"
      || idTokenClaims?.email_verified === true
      || idTokenClaims?.email_verified === "true";
    if (!profileResponse.ok || !profile.sub || !emailVerified || !email) {
      throw Object.assign(new Error("Google account needs a verified email"), { statusCode: 403 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const userId = await this.upsertIdentity(client, {
        provider: "google",
        subject: String(profile.sub),
        email,
        displayName: String(profile.name || email.split("@")[0]),
        profile: { picture: profile.picture || null },
      });
      await client.query("commit");
      await this.createSession(response, userId, "google", client);
      return safeRedirect(found.rows[0].redirect_path);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async upsertIdentity(client, identity) {
    const existing = await client.query("select user_id from public.user_identities where provider = $1 and provider_subject = $2", [identity.provider, identity.subject]);
    let userId = existing.rows[0]?.user_id;
    if (!userId) {
      const user = await client.query(`insert into public.users (email, display_name, role, last_login_at)
        values ($1, $2, 'user', now()) on conflict (email) do update set display_name = coalesce(excluded.display_name, public.users.display_name), last_login_at = now(), updated_at = now() returning id`, [identity.email, identity.displayName]);
      userId = user.rows[0].id;
      await client.query(`insert into public.user_identities
        (user_id, provider, provider_subject, provider_login, email, email_verified, profile_json)
        values ($1, $2, $3, $4, $5, true, $6)`, [userId, identity.provider, identity.subject, identity.login || null, identity.email, identity.profile || {}]);
    } else {
      await client.query("update public.users set last_login_at = now(), updated_at = now() where id = $1", [userId]);
    }
    return userId;
  }

  async startEmail(emailInput) {
    this.ensureReady();
    if (!this.providers().email) throw Object.assign(new Error("Email login is unavailable"), { statusCode: 503 });
    const email = normalizeEmail(emailInput);
    if (!email) throw Object.assign(new Error("Enter a valid email address"), { statusCode: 400 });
    const recent = await this.pool.query("select count(*)::int as count from public.auth_challenges where lower(email) = $1 and created_at > now() - interval '15 minutes'", [email]);
    if (recent.rows[0].count >= 5) throw Object.assign(new Error("Too many login requests; try later"), { statusCode: 429 });
    const raw = token();
    await this.pool.query(`insert into public.auth_challenges
      (challenge_hash, challenge_type, email, expires_at) values ($1, 'email_magic_link', $2, now() + interval '15 minutes')`, [digest(raw), email]);
    const link = `${this.config.publicOrigin}/api/auth/email/verify?token=${encodeURIComponent(raw)}`;
    const sent = await this.fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${this.config.resendApiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: this.config.emailFrom, to: [email], subject: "Sign in to MundusX", html: `<p>Use this single-use link to sign in:</p><p><a href="${link}">Sign in to MundusX</a></p><p>This link expires in 15 minutes.</p>` }) });
    if (!sent.ok) throw Object.assign(new Error("Login email could not be sent"), { statusCode: 502 });
  }

  async finishEmail(raw, response) {
    this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(`update public.auth_challenges set consumed_at = now()
        where challenge_hash = $1 and challenge_type = 'email_magic_link' and consumed_at is null and expires_at > now()
        returning email, redirect_path`, [digest(raw)]);
      if (found.rowCount !== 1) throw Object.assign(new Error("Invalid or expired login link"), { statusCode: 400 });
      const email = normalizeEmail(found.rows[0].email);
      const userId = await this.upsertIdentity(client, { provider: "email", subject: email, email, displayName: email.split("@")[0] });
      await client.query("commit");
      await this.createSession(response, userId, "email", client);
      return safeRedirect(found.rows[0].redirect_path);
    } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async listUserSkills(userId, { enabledOnly = false } = {}) {
    this.ensureReady();
    const result = await this.pool.query(`select skill_id, slug, title, description, content, enabled, created_at, updated_at
      from public.user_skills where user_id = $1 ${enabledOnly ? "and enabled = true" : ""}
      order by updated_at desc limit 50`, [userId]);
    return result.rows;
  }

  async saveUserSkill(userId, input = {}, skillId = null) {
    this.ensureReady();
    const values = [userId, input.slug, input.title, input.description, input.content, input.enabled !== false];
    if (skillId) {
      if (!UUID_PATTERN.test(String(skillId))) throw Object.assign(new Error("Skill id is invalid"), { statusCode: 400 });
      const result = await this.pool.query(`update public.user_skills
        set slug = $2, title = $3, description = $4, content = $5, enabled = $6, updated_at = now()
        where user_id = $1 and skill_id = $7
        returning skill_id, slug, title, description, content, enabled, created_at, updated_at`, [...values, skillId]);
      if (result.rowCount !== 1) throw Object.assign(new Error("Personal skill not found"), { statusCode: 404 });
      return result.rows[0];
    }
    const result = await this.pool.query(`insert into public.user_skills
      (user_id, slug, title, description, content, enabled) values ($1, $2, $3, $4, $5, $6)
      returning skill_id, slug, title, description, content, enabled, created_at, updated_at`, values);
    return result.rows[0];
  }

  async deleteUserSkill(userId, skillId) {
    this.ensureReady();
    if (!UUID_PATTERN.test(String(skillId))) throw Object.assign(new Error("Skill id is invalid"), { statusCode: 400 });
    const result = await this.pool.query("delete from public.user_skills where user_id = $1 and skill_id = $2 returning skill_id", [userId, skillId]);
    if (result.rowCount !== 1) throw Object.assign(new Error("Personal skill not found"), { statusCode: 404 });
    return { deleted: true, skill_id: result.rows[0].skill_id };
  }

  async globalSkillOverrides() {
    this.ensureReady();
    const result = await this.pool.query(`select skill_id, content, enabled, version, updated_at
      from public.global_skill_overrides order by skill_id`);
    return result.rows;
  }

  async saveGlobalSkill(session, skillId, input = {}) {
    this.ensureReady();
    if (!isSkillAdministrator(session?.role)) throw Object.assign(new Error("Platform administrator access is required"), { statusCode: 403 });
    const result = await this.pool.query(`insert into public.global_skill_overrides
      (skill_id, content, enabled, updated_by) values ($1, $2, $3, $4)
      on conflict (skill_id) do update set content = excluded.content, enabled = excluded.enabled,
        version = public.global_skill_overrides.version + 1, updated_by = excluded.updated_by, updated_at = now()
      returning skill_id, content, enabled, version, updated_at`,
    [skillId, input.content, input.enabled !== false, session.id]);
    return result.rows[0];
  }
}

export function isSkillAdministrator(role) {
  return ["admin", "platform_admin", "super_admin"].includes(String(role || "").toLowerCase());
}

export function csrfToken(request) {
  return parseCookies(request.headers.cookie)[CSRF_COOKIE] || null;
}
