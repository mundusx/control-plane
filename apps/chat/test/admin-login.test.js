import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { adminLoginAssertion, handleAdminLogin } from "../src/features/admin-login.js";

const secret = "test-secret-that-is-at-least-32-characters";
const nonce = "a".repeat(64);
const origin = "https://control.mundusx.ai";
test("admin assertion is signed, short lived, audience and challenge bound", () => {
  const [body, signature] = adminLoginAssertion({ email:"Admin@Example.com", provider:"google" }, nonce, origin, secret, 1000000).split(".");
  assert.equal(signature, createHmac("sha256", secret).update(body).digest("hex"));
  assert.deepEqual(JSON.parse(Buffer.from(body, "hex")), {
    kind:"mundusx-admin-login-v1", email:"admin@example.com", nonce, audience:origin, expires:1060,
  });
});
test("non-Google identities, unsafe destinations, missing keys and invalid challenges cannot issue assertions", () => {
  for (const [identity, challenge, target, key] of [
    [{email:"admin@example.com",provider:"email"},nonce,origin,secret],
    [{email:"admin@example.com",provider:"google"},"bad",origin,secret],
    [{email:"admin@example.com",provider:"google"},nonce,"http://mundusx.ai",secret],
    [{email:"admin@example.com",provider:"google"},nonce,origin,""],
    [{email:"admin@example.com",provider:"google"},nonce,origin+"/attacker",secret],
  ]) assert.throws(() => adminLoginAssertion(identity,challenge,target,key));
});
test("an unauthenticated admin login round trip uses the existing Google callback", async () => {
  let status, headers;
  const response = { writeHead(s,h) {status=s;headers=h;}, end() {} };
  await handleAdminLogin({ request:{method:"GET"}, response, url:new URL("https://chat.mundusx.ai/api/auth/control-plane?state="+nonce), authStore:{googleAdminIdentity:async()=>null}, origin, secret });
  assert.equal(status,303);
  assert.equal(new URL(headers.Location,"https://chat.mundusx.ai").searchParams.get("return_to"),"/api/auth/control-plane?state="+nonce);
  assert.equal(headers["Cache-Control"],"no-store");
});
test("verified Google identity redirects only to the configured control-plane audience", async () => {
  let headers;
  const response = { writeHead(s,h) {assert.equal(s,303);headers=h;}, end() {} };
  await handleAdminLogin({ request:{method:"GET"}, response, url:new URL("https://chat.mundusx.ai/api/auth/control-plane?state="+nonce+"&redirect_uri=https://evil.example"), authStore:{googleAdminIdentity:async()=>({email:"admin@example.com",provider:"google"})}, origin, secret });
  assert.equal(new URL(headers.Location).origin,origin);
  assert.equal(headers["Referrer-Policy"],"no-referrer");
  assert.ok(!headers.Location.includes(secret));
});
