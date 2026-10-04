import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

let transporter = null;
const getTransporter = () => {
  if (transporter || !config.mail.host) return transporter;
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  return transporter;
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const signVerifyToken = (user) =>
  jwt.sign({ purpose: 'verify-email', email: user.email }, config.jwtSecret, { expiresIn: '7d' });

export const verifyEmailToken = (token) => {
  const payload = jwt.verify(token, config.jwtSecret);
  if (payload.purpose !== 'verify-email') throw new Error('Wrong token');
  return payload;
};

const welcomeHtml = (name, link) => `<!doctype html><html><body style="margin:0;background:#f3f6f5;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;"><tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;padding:32px;">
<tr><td style="font-size:22px;font-weight:700;color:#0b6b4f;">MedVault</td></tr>
<tr><td style="padding-top:20px;font-size:20px;font-weight:700;color:#14201b;">Welcome to MedVault, ${esc(name)}!</td></tr>
<tr><td style="padding-top:12px;font-size:15px;line-height:22px;color:#44514b;">Please click on the button below to verify your email.</td></tr>
<tr><td style="padding:24px 0;"><a href="${esc(link)}" style="display:inline-block;background:#0b6b4f;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:999px;">Verify my email</a></td></tr>
<tr><td style="font-size:12px;line-height:18px;color:#7a8680;">If you didn't create a MedVault account, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;

// Fire-and-forget: callers don't await this, and it never throws.
export async function sendWelcomeEmail(user) {
  try {
    const link = `${config.publicApiUrl}/api/auth/verify-email?token=${encodeURIComponent(signVerifyToken(user))}`;
    const t = getTransporter();
    if (!t) {
      if (config.env !== 'test') console.log(`[mail] SMTP not configured - welcome email for ${user.email} not sent. Button link: ${link}`);
      return false;
    }
    await t.sendMail({
      from: config.mail.from,
      to: user.email,
      subject: 'Welcome to MedVault',
      text: `Welcome to MedVault, ${user.name}!\n\nPlease click the link below to verify your email:\n${link}\n`,
      html: welcomeHtml(user.name, link),
    });
    return true;
  } catch (err) {
    console.error('[mail] Could not send welcome email:', err.message);
    return false;
  }
}
