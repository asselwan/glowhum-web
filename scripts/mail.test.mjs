import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAILGUN_API_KEY = 'key-test-1234567890';
process.env.MAILGUN_DOMAIN = 'bynomoi.com';

const { sendMail, mailConfigured, orderReadyEmail, orderPaidEmail } = await import('../mail.mjs');

function withFakeFetch(handler, run) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return run(calls).finally(() => { globalThis.fetch = realFetch; });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('mailConfigured is true only when both key and domain are set', () => {
  assert.equal(mailConfigured(), true);
});

test('sendMail posts to the Mailgun v3 messages endpoint with basic auth and form body', () =>
  withFakeFetch(
    () => jsonResponse(200, { id: '<msg-1@bynomoi.com>', message: 'Queued. Thank you.' }),
    async (calls) => {
      const outcome = await sendMail({ to: 'customer@example.com', subject: 'Your Glowhum episode is ready', text: 'ready', html: '<p>ready</p>' });
      assert.equal(outcome.sent, true);
      assert.equal(outcome.id, '<msg-1@bynomoi.com>');
      assert.equal(calls.length, 1);
      const [{ url, options }] = calls;
      assert.equal(url, 'https://api.mailgun.net/v3/bynomoi.com/messages');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from('api:key-test-1234567890').toString('base64')}`);
      assert.ok(options.body instanceof URLSearchParams);
    },
  ));

test('sendMail reports a non-2xx Mailgun response as not sent, without throwing', () =>
  withFakeFetch(
    () => jsonResponse(401, { message: 'Forbidden' }),
    async () => {
      const outcome = await sendMail({ to: 'customer@example.com', subject: 'x', text: 'x' });
      assert.equal(outcome.sent, false);
      assert.equal(outcome.status, 401);
    },
  ));

test('sendMail reports a network failure as not sent, without throwing', () =>
  withFakeFetch(
    () => { throw new Error('ECONNREFUSED'); },
    async () => {
      const outcome = await sendMail({ to: 'customer@example.com', subject: 'x', text: 'x' });
      assert.equal(outcome.sent, false);
      assert.equal(outcome.reason, 'request_error');
    },
  ));

test('sendMail refuses to send with a missing recipient, subject or body -- never a blank email', () =>
  withFakeFetch(
    () => jsonResponse(200, {}),
    async (calls) => {
      const outcome = await sendMail({ to: '', subject: 'x', text: 'x' });
      assert.equal(outcome.sent, false);
      assert.equal(outcome.reason, 'missing_fields');
      assert.equal(calls.length, 0);
    },
  ));

test('orderReadyEmail links to the order-status page and includes the direct video link', () => {
  const { subject, text, html } = orderReadyEmail({ orderId: 'cs_live_abc123', topic: 'A calm morning routine', videoUrl: 'https://www.youtube.com/watch?v=xyz' });
  assert.match(subject, /ready/i);
  assert.match(text, /https:\/\/glowhum\.com\/order\?order_id=cs_live_abc123/);
  assert.match(text, /https:\/\/www\.youtube\.com\/watch\?v=xyz/);
  assert.match(text, /A calm morning routine/);
  assert.match(html, /href="https:\/\/glowhum\.com\/order\?order_id=cs_live_abc123"/);
});

test('orderReadyEmail omits the direct video link line when no video URL is known yet', () => {
  const { text } = orderReadyEmail({ orderId: 'cs_live_abc123', topic: null, videoUrl: null });
  assert.doesNotMatch(text, /Direct video link/);
});

test('orderPaidEmail states the founding-order promise and refund guarantee', () => {
  const { subject, text } = orderPaidEmail({ orderId: 'cs_live_abc123', topic: 'A calm morning routine' });
  assert.match(subject, /received/i);
  assert.match(text, /three vertical cuts/);
  assert.match(text, /full refund/);
  assert.match(text, /cs_live_abc123/);
});

test('sendMail is a safe no-op (never throws) when Mailgun is not configured', async () => {
  const savedKey = process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_API_KEY;
  const mod = await import('../mail.mjs?unconfigured');
  const outcome = await mod.sendMail({ to: 'a@b.com', subject: 'x', text: 'x' });
  assert.equal(outcome.sent, false);
  assert.equal(outcome.reason, 'mail_not_configured');
  process.env.MAILGUN_API_KEY = savedKey;
});
