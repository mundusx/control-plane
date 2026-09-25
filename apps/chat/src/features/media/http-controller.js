import { pipeline } from "node:stream/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { MediaQueue } from "./queue.js";
import { mediaQuote, ACTIVE_VIDEO_PROFILES } from "./pricing.js";
import { MediaAccounting } from "./accounting.js";
import { httpError } from "../../shared/http-error.js";
import { MAX_VIDEO_BYTES } from "./video.js";
import { MAX_IMAGE_BYTES } from "./png.js";

export function createMediaHttpController({ store, authStore, operatorToken, readJsonBody, sendJson, admitWorker }) {
  const queue = store ? new MediaQueue(store, admitWorker) : null;
  const accounting = store ? new MediaAccounting(store) : null;
  return async function handleMedia({ request, response, url }) {
    const worker = url.pathname.match(/^\/api\/media\/worker\/(claim|heartbeat|reserve|complete|fail)$/);
    const jobs = url.pathname.match(/^\/api\/media\/jobs(?:\/([0-9a-f-]{36}))?$/);
    const profiles = url.pathname === "/api/media/profiles";
    const price = url.pathname === "/api/media/quote";
    const compute = url.pathname.match(/^\/api\/media\/computations\/([^/]+)$/);
    const internal = url.pathname.match(/^\/api\/media\/accounting\/(quote|bind|settle)$/);
    const api = url.pathname.match(/^\/api\/media\/artifacts(?:\/([0-9a-f-]{36})(?:\/(content|link))?)?$/);
    const download = url.pathname.match(/^\/media\/([0-9a-f-]{36})\/(image\.png|video\.mp4)$/);
    if (!api && !download && !price && !compute && !internal && !worker && !jobs && !profiles) return false;
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (!store) throw httpError(503, "Image storage is not configured");
    if (worker) {
      if (request.method !== "POST") throw httpError(405, "Method not allowed");
      const body = await readJsonBody(request);
      const device = await queue.authenticate(request, url.pathname, body);
      const result = worker[1] === "claim" ? { job: await queue.claim(device, body.profiles) } : await queue[worker[1]](device.node_id, body);
      sendJson(response, 200, result); return true;
    }
    if (internal) {
      const digest = (value) => createHash("sha256").update(String(value)).digest();
      const supplied = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!operatorToken || !timingSafeEqual(digest(supplied), digest(operatorToken))) throw httpError(401, "Dispatcher authorization required");
      if (request.method !== "POST") throw httpError(405, "Method not allowed");
      const method = { quote: "quoteJob", bind: "bindArtifact", settle: "settle" }[internal[1]];
      sendJson(response, 200, await accounting[method](await readJsonBody(request)));
      return true;
    }

    // These two capability routes deliberately precede the browser login/CSRF gate.
    if (download && ["GET", "HEAD"].includes(request.method)) {
      const { file, record } = await store.download(download[1], url.searchParams.get("token"));
      if ((download[2] === "video.mp4") !== (record.content_type === "video/mp4")) { await file.close(); throw httpError(404, "Media not found"); }
      const source = file.createReadStream({ autoClose: false });
      const expiry = setTimeout(() => source.destroy(new Error("Image link expired")),
        Math.max(1, Math.min(2147483647, new Date(record.expires_at).getTime() - store.now())));
      expiry.unref();
      try {
        response.writeHead(200, {
          "Content-Type": record.content_type, "Content-Length": record.byte_size,
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": `${url.searchParams.get("inline") === "1" ? "inline" : "attachment"}; filename="${record.artifact_id}.${record.content_type === "video/mp4" ? "mp4" : "png"}"`,
        });
        if (request.method === "HEAD") { source.destroy(); response.end(); }
        else await pipeline(source, response);
      } finally { clearTimeout(expiry); source.destroy(); await file.close(); }
      return true;
    }
    if (api?.[2] === "content" && request.method === "PUT") {
      const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      const row = await store.lookup(api[1]);
      store.authorizeUpload(row, token);
      const length = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length !== row.byte_size || length < 1 || length > (row.content_type === "video/mp4" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) || request.headers["transfer-encoding"]) {
        throw httpError(413, "Content-Length must match the reserved image size");
      }
      if (request.headers["content-type"] !== (row.content_type ?? "image/png")) throw httpError(415, "Content-Type must match the reserved media");
      if (store.activeUploads >= 4) throw httpError(429, "Image uploads are busy; retry shortly");
      store.activeUploads++;
      const deadline = setTimeout(() => request.destroy(), 120_000); deadline.unref();
      try {
        const chunks = []; let received = 0;
        for await (const chunk of request) {
          received += chunk.length;
          if (received > length) throw httpError(413, "Image upload exceeds its reserved size");
          chunks.push(chunk);
        }
        if (received !== length) throw httpError(400, "Image upload was incomplete");
        const result = await store.upload(api[1], token, Buffer.concat(chunks, received));
        sendJson(response, 200, result);
      } finally { clearTimeout(deadline); store.activeUploads--; }
      return true;
    }

    // Reservation and link rotation use the existing account; downloading uses only the link.
    const session = await authStore.session(request);
    if (!session) throw httpError(401, "Sign in to create or manage an image result");
    if (profiles && request.method === "GET") { sendJson(response, 200, {profiles: ACTIVE_VIDEO_PROFILES.map(mediaQuote)}); return true; }
    if (jobs) {
      if (request.method === "POST" && !jobs[1]) { authStore.requireCsrf(request, session); sendJson(response, 202, await queue.submit(session.id, await readJsonBody(request))); }
      else if (request.method === "GET" && jobs[1]) sendJson(response, 200, await queue.owned(session.id, jobs[1]));
      else if (request.method === "GET") { const rows=await store.pool.query("select job_id,state,request,created_at from public.media_generation_jobs where owner_user_id=$1 order by created_at desc limit 30",[session.id]); sendJson(response, 200, {jobs:rows.rows}); }
      else throw httpError(405,"Method not allowed");
      return true;
    }
    if (price && request.method === "GET") {
      sendJson(response, 200, mediaQuote(url.searchParams.get("profile_id") ?? undefined));
      return true;
    }
    if (compute && request.method === "GET") {
      sendJson(response, 200, await accounting.owned(decodeURIComponent(compute[1]), session.id));
      return true;
    }
    if (request.method === "POST") authStore.requireCsrf(request, session);
    if (api && !api[1] && request.method === "POST") {
      sendJson(response, 201, await store.reserve(session.id, await readJsonBody(request)));
    } else if (api?.[1] && !api[2] && request.method === "GET") {
      sendJson(response, 200, await store.owned(api[1], session.id));
    } else if (api?.[2] === "link" && request.method === "POST") {
      sendJson(response, 200, await store.renewLink(api[1], session.id));
    } else throw httpError(405, "Method not allowed");
    return true;
  };
}
