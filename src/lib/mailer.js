import nodemailer from "nodemailer";
import { isProduction } from "./env.js";
// Production VMs often block SMTP 587/465 — prefer ZeptoMail or Resend (HTTPS :443).

export const MAIL_FROM = process.env.MAIL_FROM || "no-reply@nexwapi.com";
export const MAIL_SUPPORT = process.env.MAIL_SUPPORT || "hello@nexwapi.com";
export const APP_URL = (process.env.APP_URL || process.env.CORS_ORIGIN || "https://nexwapi.com").split(",")[0].trim();
const APP_DASHBOARD_URL = (process.env.APP_DASHBOARD_URL || "https://app.nexwapi.com").replace(/\/$/, "");
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "Nexwapi";

let transporter = null;
let activeTransportKey = null;

export function mailConfigured() {
  return Boolean(
    String(process.env.SMTP_HOST || "").trim() &&
    String(process.env.SMTP_USER || "").trim() &&
    String(process.env.SMTP_PASS || "").trim()
  );
}

export function resendConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
}

export function zeptomailConfigured() {
  return Boolean(String(process.env.ZEPTOMAIL_TOKEN || "").trim());
}

/** True when any outbound email channel is configured. */
export function emailDeliveryConfigured() {
  return zeptomailConfigured() || resendConfigured() || mailConfigured();
}

/**
 * auto | zeptomail | resend | smtp
 * auto: ZeptoMail → Resend → SMTP
 */
export function emailProvider() {
  const mode = String(process.env.EMAIL_PROVIDER || "auto").toLowerCase();
  if (mode === "zeptomail") return zeptomailConfigured() ? "zeptomail" : "none";
  if (mode === "resend") return resendConfigured() ? "resend" : "none";
  if (mode === "smtp") return mailConfigured() ? "smtp" : "none";
  if (zeptomailConfigured()) return "zeptomail";
  if (resendConfigured()) return "resend";
  if (mailConfigured()) return "smtp";
  return "none";
}

function smtpAllowed() {
  if (String(process.env.SMTP_DISABLED || "").toLowerCase() === "true") return false;
  return emailProvider() === "smtp";
}

function smtpTimeouts() {
  const fast = isProduction() && emailProvider() === "smtp";
  return {
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || (fast ? 3500 : 8000)),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || (fast ? 3500 : 8000)),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || (fast ? 5000 : 12000)),
  };
}

export function logEmailConfig() {
  const provider = emailProvider();
  if (provider === "none") {
    console.warn(`  Email: NOT configured${isProduction() ? " — OTP/login emails will fail" : ""}`);
    return;
  }
  if (provider === "zeptomail") {
    const host = process.env.ZEPTOMAIL_API_URL || "https://api.zeptomail.in/v1.1/email";
    console.log(`  Email: ZeptoMail (HTTPS) from ${MAIL_FROM} → ${host}`);
    return;
  }
  if (provider === "resend") {
    console.log(`  Email: Resend (HTTPS) from ${MAIL_FROM}`);
    return;
  }
  console.log(`  Email: SMTP ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} from ${MAIL_FROM}`);
  if (isProduction()) {
    console.warn(
      "  Email: WARNING — production uses SMTP only. VMs often block 587/465. Prefer ZEPTOMAIL_TOKEN (HTTPS)."
    );
  }
}

async function sendViaZeptoMail(payload) {
  const token = String(process.env.ZEPTOMAIL_TOKEN || "").trim();
  if (!token) return null;
  const endpoint = String(process.env.ZEPTOMAIL_API_URL || "https://api.zeptomail.in/v1.1/email").trim();
  const fromAddress = MAIL_FROM;
  const fromName = payload.fromName || MAIL_FROM_NAME;
  const replyTo = MAIL_FROM;

  const body = {
    from: { address: fromAddress, name: fromName },
    to: [{ email_address: { address: payload.to, name: payload.to } }],
    subject: payload.subject,
    htmlbody: payload.html || payload.text || "",
    textbody: payload.text || payload.subject,
  };
  if (replyTo) {
    body.reply_to = [{ address: replyTo, name: fromName }];
  }
  if (payload.attachments?.length) {
    body.attachments = payload.attachments.map((a) => {
      const raw = a.content;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ""), "utf8");
      return {
        name: a.filename || "attachment",
        content: buf.toString("base64"),
        mime_type: a.contentType || "application/octet-stream",
      };
    });
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Zoho-enczapikey ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`ZeptoMail API failed (${res.status}): ${errBody.slice(0, 240)}`);
  }
  return { ok: true, via: "zeptomail" };
}

async function sendViaResend(payload) {
  const key = String(process.env.RESEND_API_KEY || "").trim();
  if (!key) return null;
  const from = process.env.RESEND_FROM || `${payload.fromName || MAIL_FROM_NAME} <${MAIL_FROM}>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API failed (${res.status}): ${body.slice(0, 240)}`);
  }
  return { ok: true, via: "resend" };
}

function transportProfiles() {
  const primaryPort = Number(process.env.SMTP_PORT || 587);
  const primarySecure = primaryPort === 465 || String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
  const profiles = [{ port: primaryPort, secure: primarySecure }];
  if (primaryPort !== 465 && String(process.env.SMTP_DISABLE_465_FALLBACK || "").toLowerCase() !== "true") {
    profiles.push({ port: 465, secure: true });
  }
  return profiles;
}

function buildTransport({ port, secure }) {
  const timeouts = smtpTimeouts();
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: {
      user: String(process.env.SMTP_USER).trim(),
      pass: String(process.env.SMTP_PASS).replace(/\s/g, ""),
    },
    ...timeouts,
    tls: {
      minVersion: "TLSv1.2",
    },
  });
}

function resetTransport() {
  transporter = null;
  activeTransportKey = null;
}

function getTransport() {
  if (!mailConfigured()) return null;
  const profile = transportProfiles()[0];
  const key = `${profile.port}:${profile.secure}`;
  if (!transporter || activeTransportKey !== key) {
    transporter = buildTransport(profile);
    activeTransportKey = key;
  }
  return transporter;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function brandName(brand) {
  const n = String(brand?.productName || "").trim();
  return n || MAIL_FROM_NAME;
}

function wrap(title, bodyHtml, brand) {
  const product = escapeHtml(brandName(brand));
  const color = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(brand?.primaryColor || ""))
    ? brand.primaryColor
    : "#00a884";
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f7f6;font-family:Inter,Segoe UI,sans-serif;color:#111827">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5eee9">
    <div style="background:linear-gradient(135deg,${color},#075E54);padding:22px 28px;color:#fff">
      <div style="font-weight:800;font-size:20px">${product}</div>
      <div style="opacity:.85;font-size:13px;margin-top:4px">${escapeHtml(title)}</div>
    </div>
    <div style="padding:28px;font-size:15px;line-height:1.6">${bodyHtml}</div>
    <div style="padding:16px 28px;background:#f8fbfa;font-size:12px;color:#6b7280">
      Sent from ${product}
    </div>
  </div></body></html>`;
}

export async function sendMail({ to, subject, html, text, attachments, fromName, brand }) {
  if (!to) return { skipped: true };
  if (!emailDeliveryConfigured()) {
    console.log(`[mail:dry-run] to=${to} subject=${subject}\n${text || ""}`);
    return { skipped: true, dryRun: true };
  }

  const name = fromName || brandName(brand);
  const payload = {
    from: `${name} <${MAIL_FROM}>`,
    fromName: name,
    replyTo: MAIL_FROM,
    to,
    subject,
    html,
    text: text || subject,
    ...(attachments?.length ? { attachments } : {}),
  };

  const mode = String(process.env.EMAIL_PROVIDER || "auto").toLowerCase();
  const chain = [];
  if ((mode === "zeptomail" || mode === "auto") && zeptomailConfigured()) {
    chain.push("zeptomail");
  }
  if ((mode === "resend" || mode === "auto") && resendConfigured() && !attachments?.length) {
    chain.push("resend");
  }
  if (
    mailConfigured()
    && String(process.env.SMTP_DISABLED || "").toLowerCase() !== "true"
    && (mode === "smtp" || mode === "auto")
  ) {
    if (!chain.includes("smtp")) chain.push("smtp");
  }

  let lastErr = null;
  for (const step of chain) {
    try {
      if (step === "zeptomail") return await sendViaZeptoMail(payload);
      if (step === "resend") return await sendViaResend(payload);
      if (step === "smtp") {
        const profiles = transportProfiles();
        let smtpErr = null;
        for (let i = 0; i < profiles.length; i++) {
          const profile = profiles[i];
          try {
            const t = buildTransport(profile);
            activeTransportKey = `${profile.port}:${profile.secure}`;
            transporter = t;
            await t.sendMail(payload);
            if (i > 0) console.log(`[mail] sent via SMTP port ${profile.port} (fallback)`);
            return { ok: true, via: "smtp" };
          } catch (e) {
            smtpErr = e;
            const msg = String(e?.message || e);
            const retryable = /timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(msg);
            if (retryable && i < profiles.length - 1) {
              console.warn(`[mail] SMTP ${profile.port} failed, trying fallback…`);
              resetTransport();
              continue;
            }
            if (retryable) {
              throw new Error(
                `SMTP connection failed (${process.env.SMTP_HOST}:${profile.port}). Set ZEPTOMAIL_TOKEN (HTTPS :443).`
              );
            }
            throw e;
          }
        }
        throw smtpErr || new Error("SMTP send failed");
      }
    } catch (e) {
      lastErr = e;
      console.warn(`[mail] ${step} failed:`, e?.message || e);
    }
  }

  throw lastErr || new Error(
    isProduction()
      ? "Email delivery failed. Set ZEPTOMAIL_TOKEN in production .env."
      : "Email delivery is not configured. Set ZEPTOMAIL_TOKEN or SMTP credentials."
  );
}

export async function sendOtpEmail(to, code, purpose, brand) {
  const labels = {
    login: "Login verification",
    signup: "Account verification",
    reset: "Password reset",
    user_add: "Add team member",
    user_delete: "Remove team member",
    contact_delete: "Delete contact",
    wa_disconnect: "Disconnect WhatsApp",
    api_create: "Create API key",
    api_delete: "Delete API key",
  };
  const title = labels[purpose] || "Verification code";
  const product = brandName(brand);
  const r = await sendMail({
    to,
    brand,
    fromName: product,
    subject: `${code} is your ${product} ${title} code`,
    text: `Your ${product} code is ${code}. It expires in 10 minutes.`,
    html: wrap(title, `<p>Use this code to continue:</p>
      <p style="font-size:32px;font-weight:800;letter-spacing:8px;color:#075E54">${code}</p>
      <p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`, brand),
  });
  if (r?.skipped || r?.dryRun) {
    throw new Error("OTP email could not be sent. Configure ZEPTOMAIL_TOKEN or SMTP in backend .env.");
  }
  return r;
}

export async function sendWelcome(to, name, brand) {
  const product = brandName(brand);
  const dash = brand?.slug ? `${APP_DASHBOARD_URL}/login?partner=${encodeURIComponent(brand.slug)}` : `${APP_DASHBOARD_URL}/dashboard`;
  return sendMail({
    to,
    brand,
    fromName: product,
    subject: `Welcome to ${product} — your 7-day trial is live`,
    html: wrap("Welcome", `<p>Hi ${escapeHtml(name) || "there"},</p>
      <p>Your ${escapeHtml(product)} workspace is ready. You have a <b>7-day free trial</b> to connect WhatsApp, send campaigns, and run your inbox.</p>
      <p><a href="${dash}" style="display:inline-block;background:#00a884;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700">Open dashboard</a></p>`, brand),
  });
}

export async function sendPartnerActivated({ to, name, productName, slug, loginUrl }) {
  const product = productName || name || "your white-label CRM";
  const url = loginUrl || `${APP_DASHBOARD_URL}/login`;
  return sendMail({
    to,
    fromName: MAIL_FROM_NAME,
    subject: `${product} is live — payment confirmed`,
    html: wrap("You're activated", `<p>Hi ${escapeHtml(name) || "there"},</p>
      <p>Nexwapi confirmed your payment. Your agency console is live as <b>${escapeHtml(product)}</b>.</p>
      <p>Log in, set your logo, and add clients. They will see your brand — not Nexwapi.</p>
      <p><a href="${url}" style="display:inline-block;background:#00a884;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700">Open agency console</a></p>
      <p style="color:#64748b;font-size:13px">Share client login: ${escapeHtml(APP_DASHBOARD_URL)}/login?partner=${escapeHtml(slug || "")}</p>`),
  });
}

export async function sendAgentInvite({ to, name, inviterName, password, role, brand }) {
  const product = brandName(brand);
  const loginUrl = brand?.slug
    ? `${APP_DASHBOARD_URL}/login?partner=${encodeURIComponent(brand.slug)}`
    : `${APP_DASHBOARD_URL}/login`;
  return sendMail({
    to,
    brand,
    fromName: product,
    subject: `${inviterName || "Your team"} invited you to ${product}`,
    text: `Hi ${name || "there"}, you have been invited to join a ${product} workspace as ${role || "Teammate"}. Login: ${loginUrl} Email: ${to} Temporary password: ${password}`,
    html: wrap(
      "You're invited",
      `<p>Hi ${escapeHtml(name) || "there"},</p>
      <p><b>${escapeHtml(inviterName) || "A teammate"}</b> invited you to ${escapeHtml(product)} as <b>${escapeHtml(role) || "Teammate"}</b>.</p>
      <p>Login with:</p>
      <ul>
        <li>Email: <b>${escapeHtml(to)}</b></li>
        <li>Temporary password: <b style="letter-spacing:1px">${escapeHtml(password)}</b></li>
      </ul>
      <p><a href="${loginUrl}" style="display:inline-block;background:#00a884;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700">Accept invitation</a></p>
      <p style="color:#64748b;font-size:13px">Change your password after first login.</p>`,
      brand
    ),
  });
}

export async function sendTrialExpiry(to, name, daysLeft) {
  return sendMail({
    to,
    subject: daysLeft <= 0 ? "Your Nexwapi trial has ended" : `Your Nexwapi trial ends in ${daysLeft} day(s)`,
    html: wrap("Trial reminder", `<p>Hi ${name || "there"},</p>
      <p>${daysLeft <= 0 ? "Your 7-day trial has ended." : `Your trial ends in <b>${daysLeft} day(s)</b>.`} Upgrade to keep campaigns, chatbots and your WhatsApp number live.</p>
      <p><a href="${APP_DASHBOARD_URL}/dashboard/upgrade" style="display:inline-block;background:#00a884;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700">Upgrade now</a></p>`),
  });
}

export async function sendPlanExpiry(to, name, plan) {
  return sendMail({
    to,
    subject: `Your Nexwapi ${plan || "plan"} is expiring`,
    html: wrap("Plan expiry", `<p>Hi ${name || "there"},</p>
      <p>Your <b>${plan || "paid"}</b> plan needs renewal so messaging and automations stay on.</p>
      <p><a href="${APP_DASHBOARD_URL}/dashboard/upgrade" style="color:#00735c;font-weight:700">Renew your plan</a></p>`),
  });
}

export async function sendInvoiceEmail(to, { invoiceNo, amount, plan, ownerName }) {
  const amountLabel = `₹${((amount || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  const planLabel = String(plan || "—").replace(/^\w/, (c) => c.toUpperCase());
  const date = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return sendMail({
    to,
    subject: `🧾 Invoice ${invoiceNo || ""} — Nexwapi Payment Confirmed`,
    html: wrap("Payment Invoice", `
      <p>Hi ${escapeHtml(ownerName || "there")},</p>
      <p>Your payment has been received. Here are your invoice details:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
        <tr style="background:#f0fdf4"><td style="padding:10px 12px;border:1px solid #d1fae5;font-weight:600">Invoice No.</td><td style="padding:10px 12px;border:1px solid #d1fae5">${invoiceNo || "—"}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:600">Date</td><td style="padding:10px 12px;border:1px solid #e5e7eb">${date}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:600">Plan</td><td style="padding:10px 12px;border:1px solid #e5e7eb">${planLabel}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:600">Amount Paid</td><td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:700;color:#15803d">${amountLabel}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:600">Payment Via</td><td style="padding:10px 12px;border:1px solid #e5e7eb">Cashfree Payments</td></tr>
      </table>
      <p>🚀 Your <b>${planLabel} plan</b> is now <b style="color:#15803d">ACTIVE</b>. Start sending campaigns, chatbots, and bulk WhatsApp messages right away.</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${APP_DASHBOARD_URL}/dashboard" style="display:inline-block;background:#00a884;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">Open Dashboard →</a>
      </p>
      <p style="font-size:13px;color:#6b7280">This is a computer-generated invoice for Nexwapi software subscription. WhatsApp conversation charges are billed separately by Meta. For support, reply to this email or WhatsApp us at +91 76311 00654.</p>
    `),
  });
}

export async function sendSuspension(to, name, reason) {
  return sendMail({
    to,
    subject: "Your Nexwapi workspace was suspended",
    html: wrap("Account suspended", `<p>Hi ${name || "there"},</p>
      <p>Your workspace has been suspended${reason ? `: ${reason}` : ""}.</p>
      <p>Open your dashboard or reply to this email if you need help restoring access.</p>`),
  });
}

export async function sendTemplateStatus(to, name, status) {
  const ok = /approv/i.test(status);
  return sendMail({
    to,
    subject: `WhatsApp template "${name}" ${ok ? "approved" : "update"}: ${status}`,
    html: wrap("Template status", `<p>Template <b>${name}</b> is now <b>${status}</b>.</p>
      <p><a href="${APP_DASHBOARD_URL}/dashboard/templates">Open templates</a></p>`),
  });
}

export async function sendCampaignStatus(to, name, status) {
  return sendMail({
    to,
    subject: `Campaign "${name}" ${status}`,
    html: wrap("Campaign update", `<p>Campaign <b>${name}</b> is now <b>${status}</b>.</p>
      <p><a href="${APP_DASHBOARD_URL}/dashboard/campaigns">Open campaigns</a></p>`),
  });
}

/** Email a generated campaign report CSV to the user. */
export async function sendCampaignReportEmail({ to, reportType, from, toDate, csvContent, campaignCount }) {
  const labels = {
    summary: "Campaign Summary Report",
    detailed: "Campaign Detailed Report",
    ctwa: "CTWA Ad Campaign Detailed Report",
  };
  const title = labels[reportType] || "Campaign Report";
  const range = from && toDate ? `${from} to ${toDate}` : "All time";
  return sendMail({
    to,
    subject: `Nexwapi ${title} — ${range}`,
    html: wrap(title, `
      <p>Your <b>${title}</b> is ready.</p>
      <p>Date range: <b>${range}</b></p>
      <p>Campaigns included: <b>${campaignCount}</b></p>
      <p>The report is attached as a CSV file. Open it in Excel or Google Sheets.</p>
      <p><a href="${APP_DASHBOARD_URL}/dashboard/reports" style="color:#00735c;font-weight:700">View reports dashboard</a></p>
    `),
    text: `${title} for ${range}. ${campaignCount} campaigns. See attached CSV.`,
    attachments: [{
      filename: `nexwapi-${reportType}-report-${from || "all"}${toDate ? `-to-${toDate}` : ""}.csv`,
      content: csvContent,
      contentType: "text/csv",
    }],
  });
}

export async function sendSupportTicketAlert({ subject, body, priority, name, email, company, plan }) {
  return sendMail({
    to: MAIL_SUPPORT,
    subject: `[Ticket] ${subject}`,
    html: wrap("New support ticket", `<p><b>${name || "Client"}</b> (${email || "—"}) opened a ticket.</p>
      <p>Company: ${company || "—"} · Plan: ${plan || "—"} · Priority: ${priority || "normal"}</p>
      <p style="white-space:pre-wrap">${String(body || "").replace(/</g, "&lt;")}</p>
      <p><a href="${APP_URL}/admin/tickets" style="color:#00735c;font-weight:700">Open tickets</a></p>`),
  });
}

export async function sendPasswordResetLink(to, email) {
  const url = `${APP_URL}/forgot-password?email=${encodeURIComponent(email)}`;
  return sendMail({
    to,
    subject: "Reset your Nexwapi password",
    html: wrap("Password reset", `<p>We received a request to reset your password.</p>
      <p><a href="${url}" style="display:inline-block;background:#00a884;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700">Reset password</a></p>
      <p>An OTP was also sent to this inbox. Use the code on that page. If you did not ask for this, ignore the email.</p>`),
  });
}
