import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const signVerifyToken = (user) =>
  jwt.sign({ purpose: 'verify-email', email: user.email }, config.jwtSecret, { expiresIn: '7d' });

export const verifyEmailToken = (token) => {
  const payload = jwt.verify(token, config.jwtSecret);
  if (payload.purpose !== 'verify-email') throw new Error('Wrong token');
  return payload;
};

const PREVIEW = 'Verify your email to get started with MedVault.';

const welcomeHtml = (name, link) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to MedVault</title></head>
<body style="margin:0;padding:0;background:#eef3f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef3f1;">${PREVIEW}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f1;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;">
<tr><td align="center">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;">
    <tr><td style="background:#0b6b4f;padding:28px 32px;">
      <span style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:0.3px;">&#10010; MedVault</span>
      <div style="font-size:13px;color:#bfe6d8;margin-top:4px;">Pharmacy inventory, expiry alerts &amp; forecasting</div>
    </td></tr>
    <tr><td style="padding:36px 32px 8px 32px;">
      <div style="font-size:22px;font-weight:700;color:#14201b;">Welcome to MedVault, ${esc(name)}!</div>
      <p style="font-size:15px;line-height:24px;color:#44514b;margin:14px 0 0 0;">Your account has been created. Please click the button below to verify your email address.</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px;">
      <a href="${esc(link)}" style="display:inline-block;background:#0b6b4f;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:15px 38px;border-radius:999px;">Verify my email</a>
    </td></tr>
    <tr><td style="padding:0 32px 8px 32px;">
      <p style="font-size:13px;line-height:20px;color:#7a8680;margin:0;">Button not working? Copy and paste this link into your browser:<br><a href="${esc(link)}" style="color:#0b6b4f;word-break:break-all;">${esc(link)}</a></p>
    </td></tr>
    <tr><td style="padding:24px 32px 32px 32px;">
      <div style="border-top:1px solid #e3eae6;padding-top:18px;font-size:12px;line-height:18px;color:#8a9690;">
        If you didn't create a MedVault account, you can safely ignore this email.<br>&copy; ${new Date().getFullYear()} MedVault. All rights reserved.
      </div>
    </td></tr>
  </table>
</td></tr></table></body></html>`;

// Fire-and-forget: callers don't await this, and it never throws.
export async function sendWelcomeEmail(user) {
  try {
    const link = `${config.publicApiUrl}/api/auth/verify-email?token=${encodeURIComponent(signVerifyToken(user))}`;
    if (!config.mail.apiKey || !config.mail.fromEmail) {
      if (config.env !== 'test') console.log(`[mail] BREVO_API_KEY / MAIL_FROM_EMAIL not set - welcome email for ${user.email} not sent. Button link: ${link}`);
      return false;
    }
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': config.mail.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: config.mail.fromName, email: config.mail.fromEmail },
        to: [{ email: user.email, name: user.name }],
        subject: 'Welcome to MedVault',
        htmlContent: welcomeHtml(user.name, link),
        textContent: `Welcome to MedVault, ${user.name}!\n\nPlease click the link below to verify your email:\n${link}\n`,
      }),
    });
    if (!res.ok) {
      console.error(`[mail] Brevo rejected the email (${res.status}):`, await res.text());
      return false;
    }
    console.log(`[mail] Welcome email sent to ${user.email}`);
    return true;
  } catch (err) {
    console.error('[mail] Could not send welcome email:', err.message);
    return false;
  }
}
