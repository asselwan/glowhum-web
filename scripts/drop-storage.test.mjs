import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Exercise the real request handler and disk storage without opening a socket.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glowhum-drop-test-'));
process.env.DROP_ROOT = root;
process.env.DROP_MAX_BYTES = '100';
const { handleDrop, serveStatic } = await import('../server.mjs');
function response() {
  return { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
}
async function upload(name, body, declaredSize = Buffer.byteLength(body)) {
  const request = {
    headers: { 'x-file-name': name, 'x-file-size': String(declaredSize) },
    resume() {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
  const res = response();
  await handleDrop(request, res, 'local-test');
  return {status:res.status, body:JSON.parse(res.body)};
}

test('report bytes and receipt remain intact, and failed uploads leave no saved files', async () => {
  try {
    for (const name of ['report.md', 'receipt.json', '../../report.md']) {
      const result = await upload(name, 'source report');
      assert.equal(result.status, 201);
      const receipt = result.body;
      assert.equal(receipt.sha256, crypto.createHash('sha256').update('source report').digest('hex'));
      assert.equal(await fs.readFile(path.join(root, receipt.id, receipt.name), 'utf8'), 'source report');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, receipt.id, 'receipt.json'), 'utf8')), receipt);
    }
    const before = await fs.readdir(root);
    assert.equal((await upload('short.md', 'short', 99)).status, 400);
    assert.equal((await upload('large.md', 'x'.repeat(101), 100)).status, 413);
    assert.deepEqual(await fs.readdir(root), before);
    const res = response();
    assert.equal(await serveStatic({url:'/drop'}, res), true);
    assert.equal(res.status, 200);
    assert.match(res.body.toString(), /No preview is available/);
    assert.match(res.body.toString(), /Publishing is not available/);
  } finally {
    await fs.rm(root, {recursive:true, force:true});
  }
});
