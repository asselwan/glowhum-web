import https from 'node:https';

// Transactional delivery email for glowhum orders. Uses Mailgun's HTTP API directly (no SDK) so
// this stays a single dependency-free file, matching the rest of this repo.
//
// Domain: MAILGUN_DOMAIN defaults to bynomoi.com, a verified NOMOI sending domain with zero
// 30-day send volume and clean SPF/DKIM/DMARC (checked live 2026-09-24) -- deliberately NOT
// mg.nomoi.ai (93.6% permanent-failure rate from Signal's cold-outbound noise, the domain
// implicated in Dain sign-in mail landing in spam) and NOT tickmarkhq.com (bounce-breaker paused).
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || 'bynomoi.com';
const MAILGUN_FROM = process.env.MAILGUN_FROM || `Glowhum <delivery@${MAILGUN_DOMAIN}>`;
const MAILGUN_API_BASE = process.env.MAILGUN_API_BASE || 'api.mailgun.net';

export function mailConfigured() {
  return Boolean(MAILGUN_API_KEY && MAILGUN_DOMAIN);
}

// Injectable for tests: pass a fake `request` to avoid a real network call.
export function sendMail({ to, subject, text, html }, { request = https.request } = {}) {
  if (!mailConfigured()) {
    return Promise.resolve({ sent: false, reason: 'mail_not_configured' });
  }
  if (!to || !subject || !text) {
    return Promise.resolve({ sent: false, reason: 'missing_fields' });
  }
  const body = new URLSearchParams({ from: MAILGUN_FROM, to, subject, text, ...(html ? { html } : {}) }).toString();
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: MAILGUN_API_BASE,
        path: `/v3/${MAILGUN_DOMAIN}/messages`,
        method: 'POST',
        auth: `api:${MAILGUN_API_KEY}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* Mailgun always returns JSON; leave null on malformed body */ }
          const sent = res.statusCode >= 200 && res.statusCode < 300;
          resolve({ sent, status: res.statusCode, id: parsed?.id || null, message: parsed?.message || raw.slice(0, 200) });
        });
      },
    );
    req.on('error', (err) => resolve({ sent: false, reason: 'request_error', error: err.message }));
    req.write(body);
    req.end();
  });
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
