import { pipeline } from "node:stream/promises";
import { httpError } from "../../shared/http-error.js";
import { MAX_IMAGE_BYTES } from "./png.js";

export function createMediaHttpController({ store, authStore, readJsonBody, sendJson }) {
  return async function handleMedia({ request, response, url }) {
    const api = url.pathname.match(/^\/api\/media\/artifacts(?:\/([0-9a-f-]{36})(?:\/(content|link))?)?$/);
    const download = url.pathname.match(/^\/media\/([0-9a-f-]{36})\/image\.png$/);
    if (!api && !download) return false;
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (!store) throw httpError(503, "Image storage is not configured");

    // These two capability routes deliberately precede the browser login/CSRF gate.
    if (download && ["GET", "HEAD"].includes(request.method)) {
      const { file, record } = await store.download(download[1], url.searchParams.get("token"));
      const source = file.createReadStream({ autoClose: false });
      const expiry = setTimeout(() => source.destroy(new Error("Image link expired")),
        Math.max(1, Math.min(2147483647, new Date(record.expires_at).getTime() - store.now())));
      expiry.unref();
      try {
        response.writeHead(200, {
          "Content-Type": "image/png", "Content-Length": record.byte_size,
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": `${url.searchParams.get("inline") === "1" ? "inline" : "attachment"}; filename="${record.artifact_id}.png"`,
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
      if (!Number.isSafeInteger(length) || length !== row.byte_size || length < 1 || length > MAX_IMAGE_BYTES || request.headers["transfer-encoding"]) {
        throw httpError(413, "Content-Length must match the reserved image size");
      }
      if (request.headers["content-type"] !== "image/png") throw httpError(415, "Only image/png is supported");
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
