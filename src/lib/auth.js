// lib/auth.js — password hashing + JWT helpers.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "./env.js";

function secret() {
  return getJwtSecret();
}
const EXPIRES = "7d";

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function comparePassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function signToken(user, extras = {}) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      companyId: user.companyId || null,
      ...extras,
    },
    secret(),
    { expiresIn: EXPIRES }
  );
}

/** Impersonation token — Super Admin acting as a client. */
export function signImpersonationToken(admin, targetUser) {
  return jwt.sign(
    {
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role: targetUser.role,
      companyId: targetUser.companyId,
      impersonatedBy: admin.id,
      impersonating: true,
    },
    secret(),
    { expiresIn: "2h" }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, secret());
  } catch {
    return null;
  }
}

export function attachUser(req, _res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = token ? verifyToken(token) : null;
  if (req.user?.impersonating && req.user?.companyId) {
    req.impersonateCompanyId = req.user.companyId;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (req.user.role !== "SUPER_ADMIN" && req.user.role !== "SuperAdmin") {
    return res.status(403).json({ error: "Super Admin access only" });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  const r = req.user.role;
  const ok = ["SUPER_ADMIN", "SuperAdmin", "OWNER", "Owner", "ADMIN", "Admin"].includes(r);
  if (!ok) return res.status(403).json({ error: "Admin access only" });
  next();
}
