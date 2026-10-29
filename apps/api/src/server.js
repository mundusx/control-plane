// Dedicated public inference edge; no browser-chat persona, planner or tool execution.
const http = require("node:http");
const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { authenticate, recordUsage, load } = require("./keys-store");
const { interactiveDefaults } = require("./policy");
const { responsesHandler } = require("./responses");
const {clientMediaRoute,mediaHeaders}=require('./client-media');
const {clientMediaClarification}=require('./client-clarification');
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-api-key, x-request-id",
  "Access-Control-Expose-Headers":
    "x-request-id, retry-after, x-mundusx-completion-id",
};
const limit = (v, def, max) => {
  const n = Number(v ?? def);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw Error("Invalid API limit");
  return n;
};
function createApi(options = {}) {
  const upstream = new URL(
    options.upstreamUrl ||
      process.env.MUNDUSX_API_UPSTREAM_URL ||
      "https://control.mundusx.ai",
  );
  if (
    !["https:", "http:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  )
    throw Error("Invalid upstream URL");
  const token =
    options.upstreamToken ?? process.env.MUNDUSX_API_UPSTREAM_TOKEN ?? "";
  const mediaUrl=options.mediaUpstreamUrl ?? process.env.MUNDUSX_API_IMAGE_UPSTREAM_URL;
  const mediaUpstream=mediaUrl?new URL(mediaUrl):null;
  if(mediaUpstream && (!['http:','https:'].includes(mediaUpstream.protocol)||mediaUpstream.username||mediaUpstream.password||mediaUpstream.search||mediaUpstream.hash||!token))throw Error('Invalid image upstream configuration');
  const mediaAgent=mediaUpstream?(mediaUpstream.protocol==='https:'?new https.Agent({keepAlive:true}):new http.Agent({keepAlive:true})):null;
  const auth = options.authenticate || authenticate,
    usage = options.recordUsage || recordUsage;
  const maxConcurrent = limit(
    options.maxConcurrent ?? process.env.MUNDUSX_API_MAX_CONCURRENT,
    4,
    128,
  );
  const maxBody = limit(
    options.maxBody ?? process.env.MUNDUSX_API_MAX_BODY_BYTES,
    8 * 1024 * 1024,
    32 * 1024 * 1024,
  );
  const maxTotal = limit(
    process.env.MUNDUSX_API_MAX_TOTAL_CONCURRENT,
    32,
    1024,
  );
  const active = new Map();
  let total = 0;
  const agent =
    upstream.protocol === "https:"
      ? new https.Agent({ keepAlive: true, maxSockets: 128 })
      : new http.Agent({ keepAlive: true, maxSockets: 128 });
  const transport = upstream.protocol === "https:" ? https : http;
  function error(
    res,
    status,
    message,
    type = "invalid_request_error",
    code = null,
  ) {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: { message, type, param: null, code } }));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0,
        chunks = [],
        over = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > maxBody) {
          over = true;
          chunks = [];
        } else if (!over) chunks.push(c);
      });
      req.on("end", () =>
        over
          ? reject(
              Object.assign(Error("Request body too large"), { status: 413 }),
            )
          : resolve(Buffer.concat(chunks)),
      );
      req.on("error", reject);
    });
  }
  function forward(req, res, key, body, path = req.url.split("?")[0], image=false) {
    const started = Date.now();
    const headers = {
      "content-type": "application/json",
      accept: req.headers.accept || "application/json",
      "x-request-id": res.getHeader("x-request-id"),
    };
    if (body) headers["content-length"] = Buffer.byteLength(body);
    if (token) headers.authorization = "Bearer " + token;
    if(image)Object.assign(headers,mediaHeaders(key,body,token));
    for (const h of [
      "x-mundusx-resume-token",
      "last-event-id",
      "idempotency-key",
    ])
      if (req.headers[h]) headers[h] = req.headers[h];
    const selected=image?mediaUpstream:upstream;
    const target = new URL(selected);
    target.pathname = selected.pathname.replace(/\/$/, "") + path;
    const pending = (image?(target.protocol==='https:'?https:http):transport).request(
      target,
      { method: req.method, headers, agent:image?mediaAgent:agent },
      (up) => {
        const h = {
          ...CORS,
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        };
        for (const name of [
          "content-type",
          "retry-after",
          "x-mundusx-completion-id",
          "x-mundusx-resume-token",
          "x-mundusx-stream-mode",
        ])
          if (up.headers[name]) h[name] = up.headers[name];
        res.writeHead(up.statusCode || 502, h);
        res.flushHeaders();
        up.pipe(res);
        up.on("error", () => res.destroy());
        up.on("end", () =>
          usage(key, { path, status: up.statusCode, ms: Date.now() - started }),
        );
      },
    );
    pending.setTimeout(600000, () => {
      pending.destroy();
      error(
        res,
        504,
        "Upstream inference timed out",
        "api_error",
        "upstream_timeout",
      );
    });
    pending.on("error", () =>
      error(
        res,
        502,
        "The inference backend is unavailable",
        "api_error",
        "upstream_unavailable",
      ),
    );
    res.on("close", () => pending.destroy());
    pending.end(body || undefined);
  }
  const handleResponses = responsesHandler({
    upstream,
    token,
    agent,
    transport,
    error,
    defaults: interactiveDefaults,
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Request-Id", randomUUID());
    for (const [name, value] of Object.entries(CORS))
      res.setHeader(name, value);
    res.socket?.setNoDelay(true);
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        return res.end(
          JSON.stringify({ status: "ok", service: "mundusx-api" }),
        );
      }
      if (req.method === "OPTIONS" && path.startsWith("/v1/")) {
        res.writeHead(204, CORS);
        return res.end();
      }
      const method =
        path === "/v1/models"
          ? "GET"
          : path === "/v1/chat/completions" || path === "/v1/responses"
            ? "POST"
            : null;
      if (!method)
        return error(
          res,
          404,
          "Endpoint not supported",
          "invalid_request_error",
          "not_found",
        );
      if (req.method !== method) {
        res.setHeader("Allow", method);
        return error(res, 405, "Method not allowed");
      }
      const value = String(req.headers.authorization || "");
      const presented = value.toLowerCase().startsWith("bearer ")
        ? value.slice(7).trim()
        : String(req.headers["x-api-key"] || "");
      const key = auth(presented);
      if (!key)
        return error(
          res,
          401,
          "A valid MundusX API key is required",
          "authentication_error",
          "invalid_api_key",
        );
      if ((active.get(key.id) || 0) >= maxConcurrent || total >= maxTotal) {
        res.setHeader("Retry-After", "2");
        return error(
          res,
          429,
          "Concurrent request limit reached",
          "rate_limit_error",
          "rate_limit_exceeded",
        );
      }
      active.set(key.id, (active.get(key.id) || 0) + 1);
      total++;
      let released = false;
      res.once("close", () => {
        if (!released) {
          released = true;
          total--;
          const n = (active.get(key.id) || 1) - 1;
          n ? active.set(key.id, n) : active.delete(key.id);
        }
      });
      if (path === "/v1/models") return forward(req, res, key, null, path);
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (e) {
        return error(
          res,
          e.status || 400,
          e.status ? e.message : "Body must be valid JSON",
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return error(res, 400, "Expected a JSON object");
      if (path === "/v1/responses")
        return await handleResponses(req, res, parsed);
      if (!Array.isArray(parsed.messages) || !parsed.messages.length)
        return error(res, 400, "messages must be a nonempty array");
      if (typeof parsed.model !== "string" || !parsed.model.trim())
        return error(res, 400, "model is required");
      if (parsed.stream !== undefined && typeof parsed.stream !== "boolean")
        return error(res, 400, "stream must be boolean");
      if (parsed.n !== undefined && parsed.n !== 1)
        return error(res, 400, "The public router supports n=1");
      if (parsed.response_format !== undefined)
        return error(
          res,
          400,
          "Structured output formats are not supported by the current public router",
        );
      const image = !!mediaUpstream && clientMediaRoute(parsed);
      const clarification = image ? clientMediaClarification(parsed) : null;
      if (clarification && clarification.action !== 'image') {
        const completion = {id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:parsed.model,
          choices:[{index:0,message:{role:'assistant',content:clarification.message},finish_reason:'stop'}],
          mundusx:{clarification_required:clarification.action==='ask',job_started:false,file_saved:false}};
        if (parsed.stream) {
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
          const chunk={id:completion.id,object:'chat.completion.chunk',created:completion.created,model:parsed.model};
          res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:completion.choices[0].message,finish_reason:null}]})+'\n\n');
          res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],mundusx:completion.mundusx})+'\n\n');
          return res.end('data: [DONE]\n\n');
        }
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        return res.end(JSON.stringify(completion));
      }
      // Resolve the format in the API only. Existing image backend and browser chat
      // remain unchanged; they receive an explicit image request with full history.
      const resolved = clarification?.action === 'image' ? {...parsed,messages:[...parsed.messages.slice(0,-1),
        {role:'user',content:clarification.prompt}]} : parsed;
      forward(req, res, key, JSON.stringify(interactiveDefaults(resolved)), path, image);
    } catch (e) {
      error(
        res,
        e.status || 500,
        e.status ? e.message : "Internal API error",
        "api_error",
      );
    }
  });
  server.headersTimeout = 30000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 65000;
  server.on("close", () => {agent.destroy();mediaAgent?.destroy();});
  return server;
}
if (require.main === module) {
  load();
  const server = createApi();
  server.listen(
    Number(process.env.PORT || process.env.MUNDUSX_API_PORT || 8080),
    "::",
    () => console.log("MundusX API listening"),
  );
}
module.exports = { createApi };
