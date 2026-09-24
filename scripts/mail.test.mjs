import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.MAILGUN_API_KEY = 'key-test-1234567890';
process.env.MAILGUN_DOMAIN = 'bynomoi.com';

const { sendMail, mailConfigured, orderReadyEmail, orderPaidEmail } = await import('../mail.mjs');

function fakeRequest({ statusCode = 200, responseBody = { id: '<msg-1@bynomoi.com>', message: 'Queued. Thank you.' } } = {}) {
  const calls = [];
  function request(options, callback) {
    calls.push(options);
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      res.emit('data', JSON.stringify(responseBody));
      res.emit('end');
    };
    return req;
  }
  return { request, calls };
}

test('mailConfigured is true only when both key and domain are set', () => {
  assert.equal(mailConfigured(), true);
});

test('sendMail posts to the Mailgun v3 messages endpoint with basic auth and form body', async () => {
  const { request, calls } = fakeRequest();
  const outcome = await sendMail(
    { to: 'customer@example.com', subject: 'Your Glowhum episode is ready', text: 'ready', html: '<p>ready</p>' },
    { request },
  );
  assert.equal(outcome.sent, true);
  assert.equal(outcome.id, '<msg-1@bynomoi.com>');
  assert.equal(calls.length, 1);
  const options = calls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.path, '/v3/bynomoi.com/messages');
  assert.equal(options.auth, 'api:key-test-1234567890');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('sendMail reports a non-2xx Mailgun response as not sent, without throwing', async () => {
  const { request } = fakeRequest({ statusCode: 401, responseBody: { message: 'Forbidden' } });
  const outcome = await sendMail({ to: 'customer@example.com', subject: 'x', text: 'x' }, { request });
  assert.equal(outcome.sent, false);
  assert.equal(outcome.status, 401);
});

test('sendMail refuses to send with a missing recipient, subject or body -- never a blank email', async () => {
  const { request, calls } = fakeRequest();
  const outcome = await sendMail({ to: '', subject: 'x', text: 'x' }, { request });
  assert.equal(outcome.sent, false);
  assert.equal(outcome.reason, 'missing_fields');
  assert.equal(calls.length, 0);
});

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
