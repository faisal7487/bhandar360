// Minimal transactional-email sender for auth flows (password reset).
//
// No SMTP/email-provider dependency is bundled — if RESEND_API_KEY is set,
// delivery goes out through Resend's HTTP API (https://resend.com) using the
// runtime's built-in fetch, so no extra npm package is required. Without that
// env var configured, the message is written to the server log instead so
// local/dev setups keep working end-to-end — the reset link just has to be
// copied out of the log rather than an inbox. Set RESEND_API_KEY (and
// MAIL_FROM) to switch on real delivery.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'Bhandar360 <onboarding@resend.dev>';

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const subject = 'Reset your Bhandar360 password';
  const text = `Hi ${name || ''},\n\nA password reset was requested for your Bhandar360 account. Click the link below to choose a new password — this link expires in 1 hour and can only be used once.\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`;

  if (!RESEND_API_KEY) {
    // Dev fallback: no email provider configured, so log the link instead of
    // silently dropping it.
    console.log(`[mailer] RESEND_API_KEY not set — would have emailed "${subject}" to ${to}:\n${resetUrl}`);
    return { delivered: false, reason: 'no-provider-configured' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[mailer] Resend API error ${res.status}: ${body}`);
    return { delivered: false, reason: 'provider-error' };
  }
  return { delivered: true };
}

module.exports = { sendPasswordResetEmail };
