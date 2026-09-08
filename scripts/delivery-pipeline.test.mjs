import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deliveryRoutes} from '../delivery.mjs';

const token = 'worker-token-that-is-long-enough-for-tests-1234';

function response() {
  return {status:null, body:null, writeHead(status) {this.status = status;}, end(body) {this.body = body;}};
}

function request(headers, body = '', method = 'POST') {
  return {headers, method, async *[Symbol.asyncIterator]() {yield Buffer.from(body);}};
}

async function call(root, pathname, method, headers, body = '') {
  const res = response();
  const handled = await deliveryRoutes(request(headers, body, method), res, pathname, root);
  assert.equal(handled, true);
  return {status:res.status, body:res.body ? JSON.parse(res.body) : null};
}

test('pipeline stages, activity and reorder use real saved artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glowhum-pipeline-'));
  const id = '0123456789abcdef0123456789abcdef';
  const report = Buffer.from('A real physai report.');
  const reportHash = crypto.createHash('sha256').update(report).digest('hex');
  const dir = path.join(root, id);
  process.env.GLOWHUM_DELIVERY_ENABLED = 'true';
  process.env.GLOWHUM_WORKER_TOKEN = token;
  process.env.GLOWHUM_YOUTUBE_CHANNEL_ID = 'UC1234567890123456789012';
  try {
    await fs.mkdir(dir, {recursive:true});
    await fs.writeFile(path.join(dir, 'report.md'), report);
    await fs.writeFile(path.join(dir, 'receipt.json'), JSON.stringify({id, name:'report.md', size:report.length, sha256:reportHash, received_at:'2026-09-07T15:00:00.000Z', status:'received', email:null}));

    const initial = await call(root, `/api/drop/${id}/receipt`, 'GET', {});
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.pipeline.stages.map(stage => [stage.id, stage.status]), [
      ['report', 'complete'], ['script', 'waiting'], ['shots', 'waiting'], ['voice', 'waiting'], ['episode', 'waiting'],
    ]);
    assert.equal(initial.body.pipeline.activity.length, 1);
    assert.equal(initial.body.reorder_available, false);

    const started = await call(root, `/api/drop/${id}/start`, 'POST', {'content-type':'application/json'}, JSON.stringify({confirm:true}));
    assert.equal(started.status, 200);
    const claimed = await call(root, '/api/worker/claim', 'POST', {authorization:`Bearer ${token}`});
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.id, id);
    const workerHeaders = claim => ({authorization:`Bearer ${token}`, 'x-worker-claim':claim, 'content-type':'application/octet-stream'});
    const uploadStage = async (stage, name, content, claim) => {
      const bytes = Buffer.from(content);
      const result = await call(root, `/api/worker/${id}/artifact`, 'POST', {...workerHeaders(claim), 'x-pipeline-stage':stage, 'x-file-name':name, 'x-file-size':String(bytes.length)}, bytes);
      assert.equal(result.status, 200);
      return result.body;
    };
    assert.equal((await call(root, `/api/worker/${id}/artifact`, 'POST', {...workerHeaders(claimed.body.claim), 'x-pipeline-stage':'voice', 'x-file-name':'voice.wav', 'x-file-size':'4'}, 'voice')).status, 409);
    await uploadStage('script', 'script.md', '# Script from the report', claimed.body.claim);
    await uploadStage('shots', 'shots.json', '{"shots":[]}', claimed.body.claim);
    await uploadStage('voice', 'voice.wav', 'voice', claimed.body.claim);
    const finished = await uploadStage('episode', 'episode.mp4', 'episode bytes', claimed.body.claim);
    assert.equal(finished.pipeline.stages.find(stage => stage.id === 'episode').status, 'complete');
    assert.equal(finished.pipeline.stages.filter(stage => stage.status === 'complete').length, 5);
    assert.equal(finished.pipeline.activity.length, 7);
    assert.equal(finished.pipeline.stages.find(stage => stage.id === 'script').artifact.size, Buffer.byteLength('# Script from the report'));
    assert.equal(finished.pipeline.stages.find(stage => stage.id === 'script').artifact.sha256, crypto.createHash('sha256').update('# Script from the report').digest('hex'));

    const stored = JSON.parse(await fs.readFile(path.join(dir, 'delivery.json'), 'utf8'));
    await fs.writeFile(path.join(dir, 'delivery.json'), JSON.stringify({...stored, status:'published'}));
    const reordered = await call(root, `/api/drop/${id}/reorder`, 'POST', {'content-type':'application/json'}, JSON.stringify({confirm:true}));
    assert.equal(reordered.status, 201);
    assert.notEqual(reordered.body.id, id);
    assert.equal(reordered.body.receipt.reordered_from, id);
    assert.equal(reordered.body.receipt.sha256, reportHash);
    assert.equal(reordered.body.receipt.pipeline.stages[0].status, 'complete');
    assert.equal(await fs.readFile(path.join(root, reordered.body.id, 'report.md'), 'utf8'), report.toString());
  } finally {
    await fs.rm(root, {recursive:true, force:true});
  }
});
