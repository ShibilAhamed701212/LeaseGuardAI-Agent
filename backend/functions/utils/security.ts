// utils/security.ts — Request guards: diagnostics access, rate limiting, outbound URL checks

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { lookup } from "dns/promises";
import { BlockList, isIP } from "net";

// ── Diagnostics access ─────────────────────────────────────────

/**
 * Diagnostic routes expose queue, error and infrastructure details.
 * - DEBUG_TOKEN set: callers must send it as `X-Debug-Token` or `Authorization: Bearer`.
 * - DEBUG_TOKEN unset: allowed outside production, hidden (404) in production.
 */
export function canViewDiagnostics(req: Request): boolean {
  const token = process.env.DEBUG_TOKEN;
  if (!token) return process.env.NODE_ENV !== "production";
  const header = req.get("x-debug-token") ?? req.get("authorization")?.replace(/^Bearer\s+/i, "");
  return header === token;
}

export const requireDiagnostics: RequestHandler = (req, res, next) => {
  if (canViewDiagnostics(req)) return next();
  res.status(404).json({ error: "Not found" });
};

// ── Rate limiting (fixed window, in memory, per client IP) ─────

export function rateLimit(opts: { windowMs: number; max: number; name: string }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Drop expired windows so the map cannot grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000).toString());
      res.status(429).json({ error: `Too many ${opts.name} requests. Please try again shortly.` });
      return;
    }
    next();
  };
}

// ── Outbound AI endpoint validation (SSRF guard) ───────────────

const blocked = new BlockList();
// IPv4: unspecified, private, CGNAT, loopback, link-local (incl. cloud metadata), multicast/reserved
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3],
] as const) blocked.addSubnet(net, prefix, "ipv4");
// IPv6: unspecified, loopback, unique-local, link-local, multicast
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP literal: treat as unsafe
}

/**
 * Throws unless `url` is an http(s) URL whose host resolves only to public addresses.
 * Set ALLOW_PRIVATE_AI_ENDPOINTS=true to allow private hosts (e.g. a self-hosted Ollama).
 */
export async function assertSafeEndpoint(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid endpoint URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Endpoint URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Endpoint URL must not contain credentials");
  }
  if (process.env.ALLOW_PRIVATE_AI_ENDPOINTS === "true") return;

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new Error("Endpoint host could not be resolved");
  if (addresses.some(isPrivateAddress)) {
    throw new Error("Endpoint URL must point to a public host");
  }
}
