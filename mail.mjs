// Transactional delivery email for glowhum orders. Uses Mailgun's HTTP API via fetch() (already
// the pattern this repo uses for outbound Stripe calls in server.mjs) so this stays a single
// dependency-free file with no separate test-only transport injection needed.
//
// Domain: MAILGUN_DOMAIN defaults to bynomoi.com, a verified NOMOI sending domain with zero
// 30-day send volume and clean SPF/DKIM/DMARC (checked live 2026-09-24) -- deliberately NOT
// mg.nomoi.ai (93.6% permanent-failure rate from Signal's cold-outbound noise, the domain
// implicated in Dain sign-in mail landing in spam) and NOT tickmarkhq.com (bounce-breaker paused).
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || 'bynomoi.com';
const MAILGUN_FROM = process.env.MAILGUN_FROM || `Glowhum <delivery@${MAILGUN_DOMAIN}>`;
// Full base URL (protocol + host [+ port]), matching STRIPE_API_BASE_URL's own pattern in
// server.mjs -- tests point this at a local http:// fake Mailgun server.
const MAILGUN_API_BASE = process.env.MAILGUN_API_BASE || 'https://api.mailgun.net';

export function mailConfigured() {
  return Boolean(MAILGUN_API_KEY && MAILGUN_DOMAIN);
}

export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    return { sent: false, reason: 'mail_not_configured' };
  }
  if (!to || !subject || !text) {
    return { sent: false, reason: 'missing_fields' };
  }
  const body = new URLSearchParams({ from: MAILGUN_FROM, to, subject, text, ...(html ? { html } : {}) });
  try {
    const res = await fetch(`${MAILGUN_API_BASE}/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* Mailgun always returns JSON; leave null on malformed body */ }
    return { sent: res.ok, status: res.status, id: parsed?.id || null, message: parsed?.message || null };
  } catch (error) {
    return { sent: false, reason: 'request_error', error: error?.message };
  }
}

export function orderReadyEmail({ orderId, topic, videoUrl }) {
  const link = `https://glowhum.com/order?order_id=${encodeURIComponent(orderId)}`;
  const topicLine = topic ? `for "${topic}" ` : '';
  const text = [
    `Your Glowhum episode ${topicLine}is ready.`,
    '',
    `Watch and download your episode and three vertical cuts: ${link}`,
    videoUrl ? `Direct video link (unlisted, only people with this link can view it): ${videoUrl}` : null,
    '',
    `Order: ${orderId}`,
    '',
    'If anything looks wrong with this delivery, reply to this email and we will fix it.',
  ].filter(Boolean).join('\n');
  const html = [
    `<p>Your Glowhum episode ${topicLine}is ready.</p>`,
    `<p><a href="${link}">Watch and download your episode and three vertical cuts</a></p>`,
    videoUrl ? `<p>Direct video link (unlisted, only people with this link can view it): <a href="${videoUrl}">${videoUrl}</a></p>` : '',
    `<p style="color:#666;font-size:13px">Order: ${orderId}</p>`,
    '<p>If anything looks wrong with this delivery, reply to this email and we will fix it.</p>',
  ].filter(Boolean).join('\n');
  return { subject: 'Your Glowhum episode is ready', text, html };
}

export function orderPaidEmail({ orderId, topic }) {
  const link = `https://glowhum.com/order?order_id=${encodeURIComponent(orderId)}`;
  const topicLine = topic ? ` for "${topic}"` : '';
  const text = [
    `We received your order${topicLine}.`,
    '',
    'You are a founding order. We produce your episode and three vertical cuts and email them to you when ready.',
    'If we cannot deliver, you get a full refund.',
    '',
    `Track your order: ${link}`,
    `Order: ${orderId}`,
  ].join('\n');
  const html = [
    `<p>We received your order${topicLine}.</p>`,
    '<p>You are a founding order. We produce your episode and three vertical cuts and email them to you when ready. If we cannot deliver, you get a full refund.</p>',
    `<p><a href="${link}">Track your order</a></p>`,
    `<p style="color:#666;font-size:13px">Order: ${orderId}</p>`,
  ].join('\n');
  return { subject: 'Glowhum order received', text, html };
}
