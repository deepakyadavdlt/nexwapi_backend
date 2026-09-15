// WhatsApp Cloud API — business profile (about, logo, contact details)
import { WA } from "../config/whatsapp.js";

export function platformWaCreds() {
  if (!WA.phoneNumberId || !WA.accessToken) return null;
  if (String(WA.accessToken).startsWith("EAAG...")) return null;
  return { phoneNumberId: WA.phoneNumberId, accessToken: WA.accessToken };
}

const VERSION = WA.version || "v22.0";
const APP_ID = process.env.WHATSAPP_APP_ID || WA.appId;

const PROFILE_FIELDS =
  "about,address,description,email,profile_picture_url,websites,vertical";

export const VERTICALS = [
  { id: "OTHER", label: "Other" },
  { id: "PROF_SERVICES", label: "Professional services" },
  { id: "EDU", label: "Education" },
  { id: "RETAIL", label: "Retail" },
  { id: "APPAREL", label: "Apparel" },
  { id: "BEAUTY", label: "Beauty" },
  { id: "HEALTH", label: "Health" },
  { id: "HOTEL", label: "Hotel" },
  { id: "RESTAURANT", label: "Restaurant" },
  { id: "GROCERY", label: "Grocery" },
  { id: "FINANCE", label: "Finance" },
  { id: "GOVT", label: "Government" },
  { id: "NONPROFIT", label: "Nonprofit" },
  { id: "TRAVEL", label: "Travel" },
  { id: "ENTERTAIN", label: "Entertainment" },
  { id: "EVENT_PLAN", label: "Event planning" },
  { id: "AUTO", label: "Automotive" },
];

function graphError(data, fallback) {
  return data?.error?.error_user_msg || data?.error?.message || fallback;
}

export async function fetchBusinessProfile(phoneNumberId, accessToken) {
  const url = `https://graph.facebook.com/${VERSION}/${phoneNumberId}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(graphError(data, "Could not load WhatsApp profile"));
  const row = data?.data?.[0] || data || {};
  const websites = Array.isArray(row.websites) ? row.websites : row.websites ? [row.websites] : [];
  return {
    about: row.about || "",
    address: row.address || "",
    description: row.description || "",
    email: row.email || "",
    websites,
    website: websites[0] || "",
    vertical: row.vertical || "OTHER",
    profilePictureUrl: row.profile_picture_url || "",
  };
}

export async function updateBusinessProfile(phoneNumberId, accessToken, fields) {
  const body = { messaging_product: "whatsapp" };
  if (fields.about != null) body.about = String(fields.about).slice(0, 139);
  if (fields.address != null) body.address = String(fields.address).slice(0, 256);
  if (fields.description != null) body.description = String(fields.description).slice(0, 512);
  if (fields.email != null) body.email = String(fields.email).slice(0, 128);
  if (fields.vertical) body.vertical = fields.vertical;
  const sites = fields.websites || (fields.website ? [fields.website] : null);
  if (sites) {
    body.websites = sites.map((u) => String(u).trim()).filter(Boolean).slice(0, 2);
  }
  if (fields.profile_picture_handle) body.profile_picture_handle = fields.profile_picture_handle;

  const res = await fetch(
    `https://graph.facebook.com/${VERSION}/${phoneNumberId}/whatsapp_business_profile`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(graphError(data, "Could not update WhatsApp profile"));
  return data;
}

/** Upload a JPEG/PNG and return Meta resumable-upload handle for profile photo. */
export async function uploadProfilePicture(accessToken, buffer, mimetype = "image/jpeg", filename = "logo.jpg") {
  if (!APP_ID) throw new Error("WHATSAPP_APP_ID missing");
  const type = mimetype.includes("png") ? "image/png" : "image/jpeg";
  const name = filename || (type === "image/png" ? "logo.png" : "logo.jpg");
  const start = await fetch(
    `https://graph.facebook.com/${VERSION}/${APP_ID}/uploads?file_name=${encodeURIComponent(name)}&file_length=${buffer.length}&file_type=${encodeURIComponent(type)}`,
    { method: "POST", headers: { Authorization: `OAuth ${accessToken}` } }
  );
  const session = await start.json();
  if (!start.ok || !session.id) {
    throw new Error(graphError(session, "Could not start photo upload"));
  }
  const send = await fetch(`https://graph.facebook.com/${VERSION}/${session.id}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: "0",
      "Content-Type": "application/octet-stream",
    },
    body: buffer,
  });
  const done = await send.json();
  if (!send.ok || !done.h) throw new Error(graphError(done, "Photo upload failed"));
  return done.h;
}
