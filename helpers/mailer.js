const nodemailer = require('nodemailer');
const env = require('./env');
require('dotenv').config();

let transporter = null;
function getTransporter() {
    if (!process.env.SMTP_HOST) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
        });
    }
    return transporter;
}

// Email header: the logo image when MAIL_LOGO_URL is set (a public PNG, e.g. <website>/logo.png), else the name.
function brandRow(appName) {
    const logo = env.mailLogoUrl();
    const inner = logo
        ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(appName)}" width="160" style="display:block;width:160px;max-width:60%;height:auto;border:0;" />`
        : escapeHtml(appName);
    return `<tr><td style="padding:32px 32px 8px;color:#fff;font-size:22px;font-weight:bold;">${inner}</td></tr>`;
}

function otpTemplate(name, otp, subject, ttlMinutes) {
    const appName = env.appName();
    return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#151515;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;width:100%;background:#1e1e1e;border-radius:20px;">
        ${brandRow(appName)}
        <tr><td style="padding:8px 32px;color:#f5f5f5;font-size:16px;">Hi ${name || 'there'},</td></tr>
        <tr><td style="padding:8px 32px;color:#c7c7c7;font-size:15px;">${subject}. Use this code:</td></tr>
        <tr><td style="padding:16px 32px;">
          <div style="display:inline-block;padding:14px 26px;border-radius:14px;background:linear-gradient(90deg,#ff2f91,#e0157a);color:#fff;font-size:30px;letter-spacing:8px;font-weight:bold;">${otp}</div>
        </td></tr>
        <tr><td style="padding:8px 32px 32px;color:#9e9e9e;font-size:13px;">It expires in ${ttlMinutes} minutes. If you didn't request it, you can ignore this email.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function linkRows(links) {
    if (!links || !links.length) return '';
    return links.map((l) => `<tr><td style="padding:6px 32px;"><a href="${escapeHtml(l.url)}" style="display:inline-block;padding:10px 18px;border-radius:12px;background:linear-gradient(90deg,#ff2f91,#e0157a);color:#fff;font-size:14px;font-weight:bold;text-decoration:none;">${escapeHtml(l.label)}</a></td></tr>`).join('');
}

function plainTemplate(heading, lines, links) {
    const appName = env.appName();
    return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#151515;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;width:100%;background:#1e1e1e;border-radius:20px;">
        ${brandRow(appName)}
        <tr><td style="padding:8px 32px;color:#fff;font-size:18px;font-weight:bold;">${heading}</td></tr>
        ${lines.map((l) => `<tr><td style="padding:6px 32px;color:#c7c7c7;font-size:15px;">${l}</td></tr>`).join('')}
        ${linkRows(links)}
        <tr><td style="padding:0 32px 28px;"></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = {
    /**
     * Simple notification email; never throws (a failed email must not break the caller).
     * `links` ([{label, url}]) render as buttons.
     */
    SendNotice: async function (email, subject, heading, lines, links = []) {
        try {
            if (!email) return;
            const mailTransport = getTransporter();
            if (!mailTransport) {
                if (!env.isProd()) console.log(`[mailer] SMTP not configured — notice to ${email}: ${subject}`, links.map((l) => l.url));
                return;
            }
            await mailTransport.sendMail({
                from: process.env.MAIL_FROM,
                to: email,
                subject: `${subject} — ${env.appName()}`,
                text: [heading, ...lines, ...links.map((l) => `${l.label}: ${l.url}`)].join('\n'),
                html: plainTemplate(heading, lines, links),
            });
        } catch (err) {
            console.error('[mailer] notice failed:', err.message);
        }
    },

    SendOtpEmail: async function (email, name, otp, subject, ttlMinutes) {
        const mailTransport = getTransporter();
        if (!mailTransport) {
            if (env.isProd()) throw new Error('SMTP is not configured');
            console.log(`[mailer] SMTP not configured — OTP for ${email} (${subject}): ${otp}`);
            return;
        }
        await mailTransport.sendMail({
            from: process.env.MAIL_FROM,
            to: email,
            subject: `${subject} — ${env.appName()}`,
            text: `Your ${env.appName()} code is ${otp}. It expires in ${ttlMinutes} minutes.`,
            html: otpTemplate(name, otp, subject, ttlMinutes),
        });
    },
};
