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

function otpTemplate(name, otp, subject, ttlMinutes) {
    const appName = env.appName();
    return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#14081c;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;width:100%;background:#22112b;border-radius:20px;">
        <tr><td style="padding:32px 32px 8px;color:#fff;font-size:22px;font-weight:bold;">${appName}</td></tr>
        <tr><td style="padding:8px 32px;color:#e9dcf2;font-size:16px;">Hi ${name || 'there'},</td></tr>
        <tr><td style="padding:8px 32px;color:#c9b6d6;font-size:15px;">${subject}. Use this code:</td></tr>
        <tr><td style="padding:16px 32px;">
          <div style="display:inline-block;padding:14px 26px;border-radius:14px;background:linear-gradient(90deg,#8b3dff,#e64b9b);color:#fff;font-size:30px;letter-spacing:8px;font-weight:bold;">${otp}</div>
        </td></tr>
        <tr><td style="padding:8px 32px 32px;color:#9d88ab;font-size:13px;">It expires in ${ttlMinutes} minutes. If you didn't request it, you can ignore this email.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function plainTemplate(heading, lines) {
    const appName = env.appName();
    return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#14081c;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;width:100%;background:#22112b;border-radius:20px;">
        <tr><td style="padding:32px 32px 8px;color:#fff;font-size:22px;font-weight:bold;">${appName}</td></tr>
        <tr><td style="padding:8px 32px;color:#fff;font-size:18px;font-weight:bold;">${heading}</td></tr>
        ${lines.map((l) => `<tr><td style="padding:6px 32px;color:#c9b6d6;font-size:15px;">${l}</td></tr>`).join('')}
        <tr><td style="padding:0 32px 28px;"></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = {
    /** Simple notification email; never throws (a failed email must not break the caller). */
    SendNotice: async function (email, subject, heading, lines) {
        try {
            const mailTransport = getTransporter();
            if (!mailTransport) {
                if (!env.isProd()) console.log(`[mailer] SMTP not configured — notice to ${email}: ${subject}`);
                return;
            }
            await mailTransport.sendMail({
                from: process.env.MAIL_FROM,
                to: email,
                subject: `${subject} — ${env.appName()}`,
                text: [heading, ...lines].join('\n'),
                html: plainTemplate(heading, lines),
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
