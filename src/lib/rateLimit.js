// lib/rateLimit.js — lightweight in-memory rate limiter
const buckets = new Map();

function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

/**
 * @param {{ windowMs?: number; max?: number; keyFn?: (req: any) => string; message?: string }} opts
 */
export function rateLimit(opts = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 60;
  const keyFn = opts.keyFn ?? ((req) => clientIp(req));
  const message = opts.message ?? "Too many requests. Please try again later.";

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      return res.status(429).json({ error: message, code: "RATE_LIMITED" });
    }
    next();
  };
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  message: "Too many login attempts. Try again in 15 minutes.",
});

export const signupLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  message: "Too many signups from this IP. Try again later.",
});

export const apiMessageLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyFn: (req) => `api:${req.headers["x-api-key"] || clientIp(req)}`,
  message: "API rate limit exceeded. Slow down or upgrade your plan.",
});

// Prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(k);
  }
}, 5 * 60_000).unref?.();
