export const PERMISSIONS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "clients", label: "Clients & trials" },
  { key: "tickets", label: "Support tickets" },
  { key: "sales", label: "Talk to Sales" },
  { key: "notifications", label: "Notifications" },
  { key: "plans", label: "Plans" },
  { key: "pricing", label: "Pricing" },
  { key: "payments", label: "Payments" },
  { key: "revenue", label: "Revenue" },
  { key: "coupons", label: "Coupons" },
  { key: "templates", label: "Templates" },
  { key: "campaigns", label: "Campaigns" },
  { key: "usage", label: "Usage" },
  { key: "logs", label: "Logs" },
  { key: "system", label: "System" },
  { key: "settings", label: "Account settings" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "users", label: "User management" },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export function normalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((k) => PERMISSION_KEYS.includes(String(k))))];
}

export function isPlatformStaff(user) {
  if (!user) return false;
  if (user.role === "SUPER_ADMIN" || user.role === "SuperAdmin") return true;
  return (user.role === "ADMIN" || user.role === "Admin") && !user.companyId;
}

export function hasPermission(user, key) {
  if (!user) return false;
  if (user.role === "SUPER_ADMIN" || user.role === "SuperAdmin") return true;
  if (!isPlatformStaff(user)) return false;
  return normalizePermissions(user.permissions).includes(key);
}

const PATH_PERM = [
  [/^\/users/, "users"],
  [/^\/clients/, "clients"],
  [/^\/pricing/, "pricing"],
  [/^\/plans/, "plans"],
  [/^\/payments/, "payments"],
  [/^\/revenue/, "revenue"],
  [/^\/coupons/, "coupons"],
  [/^\/tickets/, "tickets"],
  [/^\/sales-leads/, "sales"],
  [/^\/templates/, "templates"],
  [/^\/campaigns/, "campaigns"],
  [/^\/usage/, "usage"],
  [/^\/analytics/, "usage"],
  [/^\/logs/, "logs"],
  [/^\/system/, "system"],
  [/^\/whatsapp/, "whatsapp"],
  [/^\/platform-profile/, "whatsapp"],
  [/^\/overview/, "dashboard"],
];

export function permissionForPath(path) {
  const p = String(path || "");
  for (const [re, key] of PATH_PERM) {
    if (re.test(p)) return key;
  }
  return null;
}
