import { Resend } from 'resend';

/**
 * Email sender. If RESEND_API_KEY is set, sends via Resend. Otherwise
 * logs the email to the console — useful for local dev (no DKIM setup
 * needed) and for confirming auth flows work before Resend is wired in.
 *
 * Never throws to the caller — email failures are logged but don't
 * block the request that triggered them. (A failed verification email
 * shouldn't crash signup; the user can request a resend.)
 */

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.EMAIL_FROM || 'noreply@zoomchat.ryteproductions.com';
const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');

async function send({ to, subject, html, text }) {
  if (!resend) {
    console.log('\n========== EMAIL (Resend not configured) ==========');
    console.log(`From: ${FROM}`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`\n${text || html}`);
    console.log('===================================================\n');
    return;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html, text });
  } catch (err) {
    console.error(`[email] failed to send "${subject}" to ${to}:`, err.message);
  }
}

export function appUrl() {
  return APP_URL;
}

export async function sendVerificationEmail({ to, token }) {
  const link = `${APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await send({
    to,
    subject: 'Verify your ZoomChat account',
    text: `Welcome to ZoomChat.\n\nClick to verify your email:\n${link}\n\nThis link expires in 24 hours.`,
    html: htmlWrap(`
      <h2>Welcome to ZoomChat</h2>
      <p>Click the button below to verify your email and finish setting up your account.</p>
      <p><a href="${link}" style="${BUTTON_STYLE}">Verify email</a></p>
      <p style="${HINT_STYLE}">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
      <p style="${HINT_STYLE}">This link expires in 24 hours.</p>
    `),
  });
}

export async function sendPasswordResetEmail({ to, token }) {
  const link = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await send({
    to,
    subject: 'Reset your ZoomChat password',
    text: `Reset your password:\n${link}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore the email.`,
    html: htmlWrap(`
      <h2>Reset your password</h2>
      <p>Click the button below to set a new password.</p>
      <p><a href="${link}" style="${BUTTON_STYLE}">Reset password</a></p>
      <p style="${HINT_STYLE}">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
      <p style="${HINT_STYLE}">This link expires in 24 hours. If you didn't request a reset, you can safely ignore this email.</p>
    `),
  });
}

export async function sendInvitationEmail({ to, token, orgName, inviterEmail }) {
  const link = `${APP_URL}/accept-invite?token=${encodeURIComponent(token)}`;
  await send({
    to,
    subject: `You've been invited to ${orgName} on ZoomChat`,
    text: `${inviterEmail} has invited you to join ${orgName} on ZoomChat.\n\nAccept the invitation:\n${link}\n\nThis link expires in 7 days.`,
    html: htmlWrap(`
      <h2>You've been invited to ${escape(orgName)}</h2>
      <p>${escape(inviterEmail)} has invited you to join their team on ZoomChat.</p>
      <p><a href="${link}" style="${BUTTON_STYLE}">Accept invitation</a></p>
      <p style="${HINT_STYLE}">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
      <p style="${HINT_STYLE}">This link expires in 7 days.</p>
    `),
  });
}

// --- Template helpers ---

const BUTTON_STYLE = 'display:inline-block;padding:12px 24px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600';
const HINT_STYLE = 'color:#6b7280;font-size:13px;margin-top:24px';

function htmlWrap(inner) {
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:40px auto;padding:24px;color:#111827;line-height:1.5">${inner}<hr style="border:none;border-top:1px solid #e5e7eb;margin-top:32px"><p style="${HINT_STYLE}">ZoomChat by RYTE Productions</p></body></html>`;
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
