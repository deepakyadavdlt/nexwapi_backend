import { prisma } from "./prisma.js";
import {
  WORKSPACE_ROLE_IDS,
  PERMISSION_GROUPS,
  ALL_PERMISSION_KEYS,
  defaultPermissionsForRole,
  normalizeRolePermMap,
  mapUserToWorkspaceRole,
  roleCan,
} from "./rolePermissions.js";

export async function getRolePermissionMap(companyId, role) {
  const r = WORKSPACE_ROLE_IDS.includes(role) ? role : "Teammate";
  const row = await prisma.rolePermission.findUnique({
    where: { companyId_role: { companyId, role: r } },
  }).catch(() => null);
  return normalizeRolePermMap(r, row?.permissions);
}

export async function getAllRolePermissions(companyId) {
  const rows = await prisma.rolePermission.findMany({ where: { companyId } }).catch(() => []);
  const byRole = Object.fromEntries(rows.map((x) => [x.role, x.permissions]));
  const roles = {};
  for (const id of WORKSPACE_ROLE_IDS) {
    roles[id] = normalizeRolePermMap(id, byRole[id]);
  }
  return {
    roles,
    catalog: PERMISSION_GROUPS,
    roleIds: WORKSPACE_ROLE_IDS,
  };
}

export async function saveRolePermissions(companyId, role, permissions) {
  if (!WORKSPACE_ROLE_IDS.includes(role)) {
    const err = new Error("Unknown role");
    err.status = 400;
    throw err;
  }
  if (role === "Owner") {
    // Owner is always full access — persist all-true for clarity
    permissions = defaultPermissionsForRole("Owner");
  }
  const normalized = normalizeRolePermMap(role, permissions);
  const row = await prisma.rolePermission.upsert({
    where: { companyId_role: { companyId, role } },
    create: { companyId, role, permissions: normalized },
    update: { permissions: normalized },
  });
  return normalizeRolePermMap(role, row.permissions);
}

export async function resolveWorkspaceRole(req) {
  const companyId = req.companyId || req.user?.companyId;
  const user = req.user;
  if (!user || !companyId) return { role: "Teammate", permissions: defaultPermissionsForRole("Teammate") };
  if (user.role === "OWNER" || user.role === "SUPER_ADMIN") {
    return { role: "Owner", permissions: defaultPermissionsForRole("Owner") };
  }
  const agent = await prisma.agent.findFirst({
    where: { companyId, email: String(user.email || "").toLowerCase() },
  }).catch(() => null);
  const role = mapUserToWorkspaceRole(user, agent);
  const permissions = await getRolePermissionMap(companyId, role);
  return { role, permissions };
}

export async function userHasWorkspacePermission(req, key) {
  const { permissions, role } = await resolveWorkspaceRole(req);
  if (role === "Owner") return true;
  return roleCan(permissions, key);
}

/**
 * Express middleware factory — blocks with 403 PERMISSION_DENIED.
 */
export function requireWorkspacePermission(key) {
  return async (req, res, next) => {
    try {
      const ok = await userHasWorkspacePermission(req, key);
      if (!ok) {
        return res.status(403).json({
          error: "You do not have permission for this action",
          code: "PERMISSION_DENIED",
          permission: key,
        });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export { ALL_PERMISSION_KEYS, PERMISSION_GROUPS, WORKSPACE_ROLE_IDS };
