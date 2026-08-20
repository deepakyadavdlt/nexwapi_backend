import nodemailer from "nodemailer";
// SMTP From: hello@nexwapi.com (Google App Password in .env)

export const MAIL_FROM = process.env.MAIL_FROM || "hello@nexwapi.com";
export const MAIL_SUPPORT = process.env.MAIL_SUPPORT || "hello@nexwapi.com";
export const APP_URL = (process.env.APP_URL || process.env.CORS_ORIGIN || "https://nexwapi.com").split(",")[0].trim();

let transporter = null;
let activeTransportKey = null;

export function mailConfigured() {
  return Boolean(
    String(process.env.SMTP_HOST || "").trim() &&
    String(process.env.SMTP_USER || "").trim() &&
    String(process.env.SMTP_PASS || "").trim()
  );
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
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: {
      user: String(process.env.SMTP_USER).trim(),
      pass: String(process.env.SMTP_PASS).replace(/\s/g, ""),
    },
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 25000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 25000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 35000),
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

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f7f6;font-family:Inter,Segoe UI,sans-serif;color:#111827">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5eee9">
    <div style="background:linear-gradient(135deg,#00a884,#075E54);padding:22px 28px;color:#fff">
      <div style="font-weight:800;font-size:20px">Nexwapi</div>
      <div style="opacity:.85;font-size:13px;margin-top:4px">${title}</div>
    </div>
    <div style="padding:28px;font-size:15px;line-height:1.6">${bodyHtml}</div>
    <div style="padding:16px 28px;background:#f8fbfa;font-size:12px;color:#6b7280">
      Support: <a href="mailto:${MAIL_SUPPORT}" style="color:#00735c">${MAIL_SUPPORT}</a>
      · Sent from ${MAIL_FROM}
    </div>
  </div></body></html>`;
}

export async function sendMail({ to, subject, html, text, attachments }) {
  if (!to) return { skipped: true };
  if (!mailConfigured()) {
    console.log(`[mail:dry-run] to=${to} subject=${subject}\n${text || ""}`);
    return { skipped: true, dryRun: true };
  }

  const payload = {
    from: `Nexwapi <${MAIL_FROM}>`,
    replyTo: MAIL_SUPPORT,
    to,
    subject,
    html,
    text: text || subject,
    ...(attachments?.length ? { attachments } : {}),
  };

  const profiles = transportProfiles();
  let lastErr = null;

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    try {
      const t = buildTransport(profile);
      activeTransportKey = `${profile.port}:${profile.secure}`;
      transporter = t;
      await t.sendMail(payload);
      if (i > 0) {
        console.log(`[mail] sent via SMTP port ${profile.port} (fallback)`);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable = /timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(msg);
      if (retryable && i < profiles.length - 1) {
        console.warn(`[mail] SMTP ${profile.port} failed, trying fallback…`);
        resetTransport();
        continue;
      }
      if (retryable) {
        throw new Error(
          `SMTP connection failed (${process.env.SMTP_HOST}:${profile.port}). VM may block outbound mail — set SMTP_PORT=465 and SMTP_SECURE=true, or open firewall for 587/465.`
        );
      }
      throw e;
    }
  }

  throw lastErr || new Error("SMTP send failed");
}

export async function sendOtpEmail(to, code, purpose) {
  const labels = {
    login: "Login verification",
    signup: "Account verification",
    reset: "Password reset",
    user_add: "Add team member",
    user_delete: "Remove team member",
    wa_disconnect: "Disconnect WhatsApp",
    api_create: "Create API key",
    api_delete: "Delete API key",
  };
  const title = labels[purpose] || "Verification code";
  const r = await sendMail({
    to,
    subject: `${code} is your Nexwapi ${title} code`,
    text: `Your Nexwapi code is ${code}. It expires in 10 minutes.`,
    html: wrap(title, `<p>Use this code to continue:</p>
      <p style="font-size:32px;font-weight:800;letter-spacing:8px;color:#075E54">${code}</p>
      <p>This code expires in 10 minutes. If you did not request it, ignore this email or write to ${MAIL_SUPPORT}.</p>`),
  });
  if (r?.skipped || r?.dryRun) {
    throw new Error("OTP email could not be sent. SMTP is not configured.");
  }
  return r;
}

export async function sendWelcome(to, name) {
  return sendMail({
    to,
    subject: "Welcome to Nexwapi — your 7-day trial is live",
    html: wrap("Welcome", `<p>Hi ${name || "there"},</p>
      <p>Your Nexwapi workspace is ready. You have a <b>7-day free trial</b> to connect WhatsApp, send campaigns, and run your inbox.</p>
      <p><a href="${APP_URL}/dashboard" style="display:inline-block;background:#00a884;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700">Open dashboard</a></p>
      <p>Need help? ${MAIL_SUPPORT}</p>`),
  });
}

export async function sendTrialExpiry(to, name, daysLeft) {
  return sendMail({
    to,
    subject: daysLeft <= 0 ? "Your Nexwapi trial has ended" : `Your Nexwapi trial ends in ${daysLeft} day(s)`,
    html: wrap("Trial reminder", `<p>Hi ${name || "there"},</p>
      <p>${daysLeft <= 0 ? "Your 7-day trial has ended." : `Your trial ends in <b>${daysLeft} day(s)</b>.`} Upgrade to keep campaigns, chatbots and your WhatsApp number live.</p>
      <p><a href="${APP_URL}/dashboard/upgrade" style="display:inline-block;background:#00a884;color:#fff;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700">Upgrade now</a></p>`),
  });
}

export async function sendPlanExpiry(to, name, plan) {
  return sendMail({
    to,
    subject: `Your Nexwapi ${plan || "plan"} is expiring`,
    html: wrap("Plan expiry", `<p>Hi ${name || "there"},</p>
      <p>Your <b>${plan || "paid"}</b> plan needs renewal so messaging and automations stay on.</p>
      <p><a href="${APP_URL}/dashboard/upgrade" style="color:#00735c;font-weight:700">Renew your plan</a></p>`),
  });
}

export async function sendInvoiceEmail(to, { invoiceNo, amount, plan }) {
  return sendMail({
    to,
    subject: `Invoice ${invoiceNo || ""} from Nexwapi`,
    html: wrap("Invoice", `<p>Thanks for your payment.</p>
      <p>Invoice: <b>${invoiceNo || "—"}</b><br/>Plan: ${plan || "—"}<br/>Amount: ₹${((amount || 0) / 100).toFixed(2)}</p>
      <p><a href="${APP_URL}/dashboard/upgrade">Download from Billing</a></p>
      <p>Questions? ${MAIL_SUPPORT}</p>`),
  });
}

export async function sendSuspension(to, name, reason) {
  return sendMail({
    to,
    subject: "Your Nexwapi workspace was suspended",
    html: wrap("Account suspended", `<p>Hi ${name || "there"},</p>
      <p>Your workspace has been suspended${reason ? `: ${reason}` : ""}.</p>
      <p>Contact ${MAIL_SUPPORT} to restore access.</p>`),
  });
}

export async function sendTemplateStatus(to, name, status) {
  const ok = /approv/i.test(status);
  return sendMail({
    to,
    subject: `WhatsApp template "${name}" ${ok ? "approved" : "update"}: ${status}`,
    html: wrap("Template status", `<p>Template <b>${name}</b> is now <b>${status}</b>.</p>
      <p><a href="${APP_URL}/dashboard/templates">Open templates</a></p>`),
  });
}

export async function sendCampaignStatus(to, name, status) {
  return sendMail({
    to,
    subject: `Campaign "${name}" ${status}`,
    html: wrap("Campaign update", `<p>Campaign <b>${name}</b> is now <b>${status}</b>.</p>
      <p><a href="${APP_URL}/dashboard/campaigns">Open campaigns</a></p>`),
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
      <p><a href="${APP_URL}/dashboard/reports" style="color:#00735c;font-weight:700">View reports dashboard</a></p>
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
