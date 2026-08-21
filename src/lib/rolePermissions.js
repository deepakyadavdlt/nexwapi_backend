/**
 * Workspace role permissions (Interakt-style RBAC for Owner/Admin/Teammate/Sales…).
 * Separate from platform SUPER_ADMIN staff permissions in permissions.js.
 */

export const WORKSPACE_ROLES = [
  { id: "Super Admin", label: "Super Admin", sales: true },
  { id: "Sales Lead", label: "Sales Lead", sales: true },
  { id: "Sales Agent", label: "Sales Agent", sales: true },
  { id: "Owner", label: "Owner", sales: false },
  { id: "Admin", label: "Admin", sales: false },
  { id: "Teammate", label: "Teammate", sales: false },
];

export const WORKSPACE_ROLE_IDS = WORKSPACE_ROLES.map((r) => r.id);

/** Permission catalog grouped for the UI */
export const PERMISSION_GROUPS = [
  {
    id: "contacts",
    title: "Contact Hub",
    icon: "contacts",
    items: [
      { key: "contacts.access", label: "Allow to access Contact Hub" },
      { key: "contacts.export", label: "Allow to Export Contacts" },
      { key: "contacts.add", label: "Allow to Add Contacts" },
      { key: "contacts.delete", label: "Allow to Delete Contacts" },
      { key: "contacts.bulk_tag", label: "Allow to bulk tag Contacts" },
    ],
  },
  {
    id: "contact_privacy",
    title: "Access to Contact details",
    icon: "key",
    items: [
      {
        key: "contacts.hide_phone_legacy",
        label: "Hide Contact's Phone number (old logic)",
        note: "Enabling this will hide Templates, Notifications, All Users and Analytics modules where phone numbers may appear.",
      },
      {
        key: "contacts.hide_phone",
        label: "Hide Contact's Phone number",
        note: "Enabling this will hide only the Phone Number of contacts from all places on the interface.",
      },
      {
        key: "contacts.hide_fields",
        label: "Hide Contact's fields data",
        note: "Enabling this will hide all Contact Fields data (including Phone Number). Exports can still be restricted separately.",
      },
    ],
  },
  {
    id: "inbox",
    title: "Inbox Module",
    icon: "inbox",
    items: [
      { key: "inbox.all", label: "Allow access to All section" },
      { key: "inbox.unassigned", label: "Allow access to Unassigned section" },
    ],
  },
  {
    id: "campaigns",
    title: "Campaigns Module",
    icon: "campaigns",
    items: [
      { key: "campaigns.create", label: "Allow access to Create New Campaign" },
      { key: "campaigns.export_report", label: "Allow export of Campaign Report" },
      { key: "campaigns.custom_reports", label: "Allow to view Custom Campaign Reports page" },
      { key: "segments.manage", label: "Allow to create or update for Segments" },
    ],
  },
  {
    id: "templates",
    title: "Templates Module",
    icon: "templates",
    items: [
      { key: "templates.ai_buttons", label: "Smart buttons suggested by AI" },
      { key: "templates.create", label: "Allow Template Creation" },
      { key: "templates.edit", label: "Allow editing of Templates" },
      { key: "templates.delete", label: "Allow Template Deletion" },
    ],
  },
  {
    id: "settings",
    title: "Settings Module",
    icon: "settings",
    items: [
      { key: "settings.agents", label: "Allow access to Agent Settings" },
      { key: "settings.api_key", label: "Allow access to API Key" },
      { key: "settings.whatsapp_setup", label: "Allow access to Whatsapp Business Setup" },
      { key: "settings.invoices", label: "Allow access to Invoice History" },
      { key: "settings.subscription", label: "Allow access to Subscription Details" },
      { key: "settings.tags", label: "Allow to manage Tags" },
      { key: "settings.addons", label: "Allow access to manage add-ons" },
      { key: "settings.wa_reconnect", label: "Allow number reconnection for Whatsapp Number" },
    ],
  },
  {
    id: "analytics",
    title: "Chat Analytics",
    icon: "analytics",
    items: [
      { key: "analytics.conversations", label: "Allow to view Conversation Analytics page" },
      { key: "analytics.export", label: "Allow to Export Data in Analytics" },
      { key: "analytics.agent_performance", label: "Allow to view Agent Performance Analytics page" },
    ],
  },
  {
    id: "commerce",
    title: "Commerce",
    icon: "commerce",
    items: [
      { key: "commerce.export_orders", label: "Allow export of Order Panel" },
    ],
  },
  {
    id: "automation",
    title: "Automation",
    icon: "automation",
    items: [
      { key: "automation.export_workflow", label: "Allow export of Workflow Report" },
      { key: "automation.welcome", label: "Allow access to Welcome Message settings" },
      { key: "automation.away", label: "Allow access to Out of Office Message settings" },
      { key: "automation.delayed", label: "Allow access to Delayed Message settings" },
      { key: "automation.custom_reply", label: "Allow access to Custom Auto Reply settings" },
      { key: "automation.workflows", label: "Allow access to Workflows" },
    ],
  },
  {
    id: "ads",
    title: "CTWA Ads",
    icon: "ads",
    items: [
      { key: "ads.ctwa", label: "Allow to view CTWA Ads page" },
    ],
  },
  {
    id: "wallet",
    title: "Wallet & Billing",
    icon: "wallet",
    items: [
      {
        key: "wallet.view",
        label: "Allow access to view Wallet balance and transactions",
        note: "Note: Wallet balance may still be visible in Campaign Creation. Disallow campaign creation separately to restrict that.",
      },
      { key: "wallet.paid_insights", label: "Allow access to Paid Message Insights" },
      { key: "wallet.billing", label: "Allow access to Billing Section" },
      { key: "wallet.subscription_manage", label: "Allow managing of Subscription and Add-ons" },
    ],
  },
  {
    id: "instagram",
    title: "Instagram",
    icon: "instagram",
    items: [
      { key: "instagram.connect", label: "Allow connecting/disconnecting Instagram account" },
    ],
  },
  {
    id: "contact_settings",
    title: "Contact Settings",
    icon: "contact_settings",
    items: [
      { key: "contacts.custom_fields", label: "Allow to add or delete custom fields to contacts" },
    ],
  },
];

export const ALL_PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

function allTrue() {
  const o = {};
  for (const k of ALL_PERMISSION_KEYS) o[k] = true;
  return o;
}

function allFalse() {
  const o = {};
  for (const k of ALL_PERMISSION_KEYS) o[k] = false;
  return o;
}

/** Interakt-like defaults per role */
export function defaultPermissionsForRole(role) {
  const r = String(role || "Teammate");
  if (r === "Owner" || r === "Super Admin") return allTrue();

  if (r === "Admin") {
    return {
      ...allTrue(),
      "wallet.billing": true,
      "settings.api_key": true,
      "settings.agents": true,
    };
  }

  if (r === "Sales Lead") {
    return {
      ...allFalse(),
      "contacts.access": true,
      "contacts.add": true,
      "contacts.export": true,
      "contacts.bulk_tag": true,
      "inbox.all": true,
      "inbox.unassigned": true,
      "campaigns.create": true,
      "campaigns.export_report": true,
      "segments.manage": true,
      "templates.create": true,
      "templates.edit": true,
      "analytics.conversations": true,
      "analytics.export": true,
      "analytics.agent_performance": true,
      "ads.ctwa": true,
      "wallet.view": true,
      "wallet.paid_insights": true,
      "settings.tags": true,
      "contacts.custom_fields": true,
    };
  }

  if (r === "Sales Agent") {
    return {
      ...allFalse(),
      "contacts.access": true,
      "contacts.add": true,
      "inbox.unassigned": true,
      "templates.create": false,
      "analytics.conversations": true,
      "ads.ctwa": true,
      "wallet.view": false,
    };
  }

  // Teammate — matches Interakt screenshots closely
  return {
    ...allFalse(),
    "contacts.access": true,
    "contacts.export": false,
    "contacts.add": false,
    "contacts.delete": false,
    "contacts.bulk_tag": false,
    "contacts.hide_phone_legacy": false,
    "contacts.hide_phone": false,
    "contacts.hide_fields": false,
    "inbox.all": false,
    "inbox.unassigned": true,
    "campaigns.create": false,
    "campaigns.export_report": true,
    "campaigns.custom_reports": false,
    "segments.manage": true,
    "templates.ai_buttons": true,
    "templates.create": true,
    "templates.edit": true,
    "templates.delete": true,
    "settings.agents": false,
    "settings.api_key": false,
    "settings.whatsapp_setup": false,
    "settings.invoices": false,
    "settings.subscription": false,
    "settings.tags": false,
    "settings.addons": false,
    "settings.wa_reconnect": true,
    "analytics.conversations": true,
    "analytics.export": true,
    "analytics.agent_performance": false,
    "commerce.export_orders": true,
    "automation.export_workflow": true,
    "automation.welcome": true,
    "automation.away": true,
    "automation.delayed": true,
    "automation.custom_reply": true,
    "automation.workflows": true,
    "ads.ctwa": true,
    "wallet.view": true,
    "wallet.paid_insights": true,
    "wallet.billing": false,
    "wallet.subscription_manage": true,
    "instagram.connect": true,
    "contacts.custom_fields": true,
  };
}

export function normalizeRolePermMap(role, input) {
  const base = defaultPermissionsForRole(role);
  if (!input || typeof input !== "object") return base;
  const out = { ...base };
  for (const k of ALL_PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, k)) {
      out[k] = Boolean(input[k]);
    }
  }
  return out;
}

export function mapUserToWorkspaceRole(user, agentRow) {
  if (!user) return "Teammate";
  if (user.role === "OWNER") return "Owner";
  if (agentRow?.role && WORKSPACE_ROLE_IDS.includes(agentRow.role)) return agentRow.role;
  if (user.role === "ADMIN") return "Admin";
  if (agentRow?.role === "Agent") return "Teammate";
  return "Teammate";
}

export function roleCan(permMap, key) {
  if (!key) return true;
  if (!permMap || typeof permMap !== "object") return false;
  return permMap[key] === true;
}
