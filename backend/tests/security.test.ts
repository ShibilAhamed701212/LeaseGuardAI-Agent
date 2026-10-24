import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { assertSafeEndpoint, canViewDiagnostics, isPrivateAddress, rateLimit } from "../functions/utils/security";

test("isPrivateAddress flags internal ranges and allows public ones", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254",
                    "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("assertSafeEndpoint rejects private hosts, bad schemes and embedded credentials", async () => {
  delete process.env.ALLOW_PRIVATE_AI_ENDPOINTS;
  await assert.rejects(assertSafeEndpoint("http://169.254.169.254/latest/meta-data"), /public host/);
  await assert.rejects(assertSafeEndpoint("http://[::1]:11434"), /public host/);
  await assert.rejects(assertSafeEndpoint("file:///etc/passwd"), /http or https/);
  await assert.rejects(assertSafeEndpoint("https://user:pw@8.8.8.8"), /credentials/);
  await assert.rejects(assertSafeEndpoint("not a url"), /Invalid/);
  await assertSafeEndpoint("https://8.8.8.8/v1");
});

test("ALLOW_PRIVATE_AI_ENDPOINTS opts in to private hosts", async () => {
  process.env.ALLOW_PRIVATE_AI_ENDPOINTS = "true";
  try {
    await assertSafeEndpoint("http://127.0.0.1:11434");
  } finally {
    delete process.env.ALLOW_PRIVATE_AI_ENDPOINTS;
  }
});

const fakeReq = (headers: Record<string, string> = {}, ip = "1.2.3.4") =>
  ({ ip, get: (h: string) => headers[h.toLowerCase()] }) as unknown as Request;

test("canViewDiagnostics requires DEBUG_TOKEN when set and hides diagnostics in production otherwise", () => {
  const env = { ...process.env };
  try {
    delete process.env.DEBUG_TOKEN;
    process.env.NODE_ENV = "development";
    assert.equal(canViewDiagnostics(fakeReq()), true);
    process.env.NODE_ENV = "production";
    assert.equal(canViewDiagnostics(fakeReq()), false);

    process.env.DEBUG_TOKEN = "s3cret";
    assert.equal(canViewDiagnostics(fakeReq()), false);
    assert.equal(canViewDiagnostics(fakeReq({ "x-debug-token": "wrong" })), false);
    assert.equal(canViewDiagnostics(fakeReq({ "x-debug-token": "s3cret" })), true);
    assert.equal(canViewDiagnostics(fakeReq({ authorization: "Bearer s3cret" })), true);
  } finally {
    process.env = env;
  }
});

test("rateLimit returns 429 after max requests per window, per IP", () => {
  const limiter = rateLimit({ name: "test", windowMs: 60_000, max: 2 });
  const statuses: number[] = [];
  const res = {
    setHeader: () => undefined,
    status(code: number) { statuses.push(code); return this; },
    json: () => undefined,
  } as unknown as Response;
  let passed = 0;
  for (let i = 0; i < 3; i++) limiter(fakeReq(), res, () => { passed++; });
  limiter(fakeReq({}, "5.6.7.8"), res, () => { passed++; });
  assert.equal(passed, 3);
  assert.deepEqual(statuses, [429]);
});
