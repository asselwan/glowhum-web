import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sendMail, orderReadyEmail } from './mail.mjs';

const idPattern = /^[a-z0-9]{12,64}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const pipelineStagePattern = /^(report|script|shots|voice|episode)$/;
const pipelineStages = [
  {id: 'report', label: 'Report', waiting: 'Waiting for a report.'},
  {id: 'script', label: 'Script', waiting: 'Waiting for the script.'},
  {id: 'shots', label: 'Shots', waiting: 'Waiting for the shot list.'},
  {id: 'voice', label: 'Voice', waiting: 'Waiting for the voice track.'},
  {id: 'episode', label: 'Episode', waiting: 'Waiting for the finished episode.'},
];
const now = () => new Date().toISOString();
const token = () => crypto.randomBytes(24).toString('hex');
const config = () => ({enabled: process.env.GLOWHUM_DELIVERY_ENABLED === 'true' && (process.env.GLOWHUM_WORKER_TOKEN || '').length >= 32 && /^UC[\w-]{22}$/.test(process.env.GLOWHUM_YOUTUBE_CHANNEL_ID || ''), channel_id: process.env.GLOWHUM_YOUTUBE_CHANNEL_ID, destination: 'YouTube', visibility: 'unlisted'});
function json(res, code, body) { res.writeHead(code, {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'}); res.end(JSON.stringify(body)); }
function fail(code, message) { throw Object.assign(new Error(message), {code}); }
function stageDefinition(id) { return pipelineStages.find((stage) => stage.id === id); }
function activityId() { return `activity_${token()}`; }
function event(stage, message, at, artifact = null) {
  return {id: activityId(), stage, message, at, artifact};
}
function pipelineFor(receipt, state = {}) {
  const existing = state.pipeline || {};
  const stages = pipelineStages.map((definition) => {
    const current = existing.stages?.find((stage) => stage.id === definition.id) || {};
    if (definition.id === 'report') {
      return {
        id: definition.id,
        label: definition.label,
        status: 'complete',
        at: current.at || receipt.received_at,
        artifact: current.artifact || {name: receipt.name, size: receipt.size, sha256: receipt.sha256},
      };
    }
    return {id: definition.id, label: definition.label, status: current.status || 'waiting', at: current.at || null, artifact: current.artifact || null};
  });
  const activity = Array.isArray(existing.activity) && existing.activity.length
    ? existing.activity
    : [event('report', 'Report saved.', receipt.received_at, {name: receipt.name, size: receipt.size, sha256: receipt.sha256})];
  return {stages, activity};
}
function withPipeline(state, receipt) { return {...state, pipeline: pipelineFor(receipt, state)}; }
function appendActivity(state, receipt, stageId, message, at = now(), artifact = null) {
  const pipeline = pipelineFor(receipt, state);
  return {...state, pipeline: {...pipeline, activity: [...pipeline.activity, event(stageId, message, at, artifact)]}};
}
function recordStage(state, receipt, stageId, artifact, at = now()) {
  const pipeline = pipelineFor(receipt, state);
  const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
  if (index < 1) fail(400, 'The report is already saved.');
  if (!pipeline.stages.slice(1, index).every((stage) => stage.status === 'complete')) fail(409, 'Finish the earlier pipeline step first.');
  const definition = stageDefinition(stageId);
  const stages = pipeline.stages.map((stage) => stage.id === stageId ? {...stage, status: 'complete', at, artifact} : stage);
  return {...state, pipeline: {...pipeline, stages, activity: [...pipeline.activity, event(stageId, `${definition.label} saved.`, at, artifact)]}};
}
function publicPipeline(receipt, state) {
  const pipeline = pipelineFor(receipt, state);
  return {
    stages: pipeline.stages.map(({id, label, status, at, artifact}) => ({id, label, status, at, artifact})),
    activity: pipeline.activity.map(({id, stage, message, at, artifact}) => ({id, stage, message, at, artifact})),
  };
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) fail(413, 'Request is too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { fail(400, 'Could not read this request.'); }
}
async function read(root, id) {
  if (!idPattern.test(id)) fail(404, 'Report not found.');
  const dir = path.join(root, id);
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(path.join(dir, 'receipt.json'), 'utf8')); } catch { fail(404, 'Report not found.'); }
  let state = {status:'received'};
  try { state = JSON.parse(await fs.readFile(path.join(dir, 'delivery.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return {dir, receipt, state};
}
async function save(dir, state) {
  const temporary = path.join(dir, `.state-${token()}`);
  await fs.writeFile(temporary, JSON.stringify(state), {mode:0o600});
  await fs.rename(temporary, path.join(dir, 'delivery.json'));
}
async function saveStageArtifact(dir, req, stageId) {
  const rawName = String(req.headers['x-file-name'] || `${stageId}.bin`);
  const name = path.basename(rawName.replace(/[\\/]/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_') || `${stageId}.bin`;
  const declaredSize = Number(req.headers['x-file-size']);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) fail(400, 'A valid pipeline file size is required.');
  const maxBytes = Number(process.env.GLOWHUM_PIPELINE_ARTIFACT_MAX_BYTES) || 1024 * 1024 * 1024;
  if (declaredSize > maxBytes) fail(413, 'This pipeline file is too large.');
  const destinationDir = path.join(dir, 'pipeline', stageId);
  await fs.mkdir(destinationDir, {recursive: true});
  const temporary = path.join(destinationDir, `.${token()}-${name}`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) fail(413, 'This pipeline file is too large.');
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (size !== declaredSize) fail(400, 'The pipeline file arrived incomplete.');
    const sha256 = hash.digest('hex');
    if (req.headers['x-file-sha256'] && req.headers['x-file-sha256'] !== sha256) fail(400, 'The pipeline file hash does not match.');
    const destination = path.join(destinationDir, `${sha256}-${name}`);
    await fs.rename(temporary, destination);
    return {name, path: path.relative(dir, destination), size, sha256};
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temporary, {force: true});
  }
}
async function locked(root, id, action) {
  const {dir} = await read(root, id);
  const lock = path.join(dir, '.delivery-lock');
  try { await fs.mkdir(lock); } catch (e) { if (e.code === 'EEXIST') fail(409, 'Another step is being saved. Check status and try again.'); throw e; }
  try { return await action(await read(root, id)); } finally { await fs.rmdir(lock); }
}
export async function publicDrop(root, id) {
  const {receipt, state} = await read(root, id);
  const settings = config();
  const pipeline = publicPipeline(receipt, state);
  return {id:receipt.id, name:receipt.name, size:receipt.size, sha256:receipt.sha256, received_at:receipt.received_at, email:receipt.email || null, reordered_from:receipt.reordered_from || null,
    status:state.status, delivery_available:settings.enabled, destination:state.destination || {service:settings.destination, channel_id:settings.channel_id || null, visibility:settings.visibility},
    preview:state.preview || null, publication:state.publication || null, requested_at:state.requested_at || null,
    approved_at:state.approved_at || null, message:state.message || null, pipeline,
    reorder_available:['ready', 'published'].includes(state.status)};
}
function workerAuthorized(req) {
  const expected = process.env.GLOWHUM_WORKER_TOKEN || '';
  const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
  return expected.length >= 32 && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
async function stream(req, res, file, type) {
  const size = (await fs.stat(file)).size;
  let start = 0, end = size - 1, partial = false;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, {'Content-Range':`bytes */${size}`}); res.end(); return; }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, {'Content-Range':`bytes */${size}`}); res.end(); return; }
    partial = true;
  }
  res.writeHead(partial ? 206 : 200, {'Content-Type':type, 'Content-Length':end-start+1, 'Accept-Ranges':'bytes', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', ...(partial ? {'Content-Range':`bytes ${start}-${end}/${size}`} : {})});
  const input = createReadStream(file, {start,end}); input.on('error', () => res.destroy()); res.on('close', () => input.destroy()); input.pipe(res);
}
export async function deliveryRoutes(req, res, pathname, root) {
  const match = /^\/api\/drop\/([a-z0-9]{12,64})\/(start|preview|publish|receipt|reorder)$/.exec(pathname);
  const worker = /^\/api\/worker\/(claim|[a-z0-9]{12,64}\/(source|preview|artifact|complete|failed))$/.exec(pathname);
  if (!match && !worker) return false;
  try {
    if (match) {
      const [,id,action] = match;
      if (req.method === 'GET' && action === 'receipt') { json(res,200,await publicDrop(root,id)); return true; }
      if (req.method === 'GET' && action === 'preview') {
        const {dir,state} = await read(root,id);
        if (!state.preview) fail(404,'Your video is not ready yet.');
        await stream(req,res,path.join(dir,'preview.mp4'),'video/mp4'); return true;
      }
      if (req.method === 'POST' && action === 'reorder') {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Send this action from your report page.');
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Open your saved report link first.');
        const input = await body(req);
        if (input.confirm !== true) fail(400, 'Confirm that you want to make another episode.');
        const source = await read(root, id);
        if (!['ready', 'published'].includes(source.state.status)) fail(409, 'Finish the current episode before making another one.');
        const newId = token();
        const newDir = path.join(root, newId);
        await fs.mkdir(newDir, {recursive: true});
        try {
          await fs.copyFile(path.join(source.dir, source.receipt.name), path.join(newDir, source.receipt.name));
          const receipt = {id:newId, name:source.receipt.name, size:source.receipt.size, sha256:source.receipt.sha256,
            received_at:now(), status:'received', email:null, reordered_from:id};
          await fs.writeFile(path.join(newDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
          const state = withPipeline({status:'received', reordered_from:id}, receipt);
          await save(newDir, state);
          json(res, 201, {id:newId, receipt:await publicDrop(root, newId)}); return true;
        } catch (error) {
          await fs.rm(newDir, {recursive:true, force:true});
          throw error;
        }
      }
      if (req.method !== 'POST' || !['start','publish'].includes(action)) fail(405,'This action is not available.');
      // JSON plus same-origin checks keep a private link from becoming a cross-site publish form.
      if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415,'Send this action from your report page.');
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403,'Open your saved report link first.');
      const input = await body(req);
      await locked(root,id,async ({dir,receipt,state}) => {
        if (action === 'start') {
          if (state.status !== 'received') return;
          if (!config().enabled) fail(503,'Video making is not connected yet. Your report is saved.');
          if (input.confirm !== true) fail(400,'Confirm that you want to make this video.');
          if (!/\.(md|txt|pdf)$/i.test(receipt.name) || receipt.size === 0) fail(400,'Choose a PDF, text or Markdown report with some content.');
          const requestedAt = now();
          await save(dir,appendActivity(withPipeline({status:'queued',requested_at:requestedAt,source_sha256:receipt.sha256,destination:{service:'YouTube',channel_id:config().channel_id,visibility:'unlisted'}}, receipt), receipt, 'pipeline', 'Pipeline queued.', requestedAt));
        } else {
          if (!state.preview || input.preview_sha256 !== state.preview.sha256) fail(409,'The preview changed. Watch the current video before publishing.');
          if (input.confirm !== true) fail(400,'Confirm that you want to publish this video.');
          if (['publish_queued','publishing','published'].includes(state.status)) return;
          if (state.status !== 'ready') fail(409,'This video is not ready to publish.');
          if (!config().enabled || state.destination.channel_id !== config().channel_id) fail(503,'Publishing is not connected to this destination.');
          await save(dir,{...state,status:'publish_queued',approved_at:now(),approved_sha256:state.preview.sha256});
        }
      });
      json(res,200,await publicDrop(root,id)); return true;
    }
    if (!workerAuthorized(req)) fail(401,'Worker access required.');
    if (worker[1] === 'claim') {
      if (req.method !== 'POST') fail(405,'Use POST.');
      if (!config().enabled) fail(503,'Delivery is not enabled.');
      const dirs = await fs.readdir(root).catch(e => { if(e.code === 'ENOENT') return []; throw e; });
      for (const id of dirs.filter(id => idPattern.test(id))) {
        let job;
        try {
          await locked(root,id,async ({dir,receipt,state}) => {
            if (!['queued','publish_queued'].includes(state.status)) return;
            const phase = state.status === 'queued' ? 'render' : 'publish';
            const claim = token();
            const claimedAt = now();
            const next = appendActivity({...state,status:phase === 'render' ? 'rendering':'publishing',claim,claimed_at:claimedAt}, receipt, 'pipeline', phase === 'render' ? 'Pipeline started.' : 'Publishing started.', claimedAt);
            await save(dir,next);
            job = {id,phase,claim,name:receipt.name,source_sha256:receipt.sha256,preview:state.preview || null,destination:state.destination};
          });
        } catch(e) { if ([404,409].includes(e.code)) continue; throw e; }
        if (job) { json(res,200,job); return true; }
      }
      json(res,200,{job:null}); return true;
    }
    const [id,action] = worker[1].split('/');
    const existing = await read(root,id);
    if (!existing.state.claim || req.headers['x-worker-claim'] !== existing.state.claim) fail(409,'This job belongs to a different worker claim.');
    if (action === 'source' && req.method === 'GET') { await stream(req,res,path.join(existing.dir,existing.receipt.name),'application/octet-stream'); return true; }
    if (req.method !== 'POST') fail(405,'Use POST.');
    await locked(root,id,async ({dir,state}) => {
      if (req.headers['x-worker-claim'] !== state.claim) fail(409,'Worker claim changed.');
      if (action === 'preview') {
        if (state.status !== 'rendering') fail(409,'This job is not waiting for a video.');
        const tmp = path.join(dir,`.video-${token()}`); let size = 0; const hash = crypto.createHash('sha256'); let prefix = Buffer.alloc(0);
        const handle = await fs.open(tmp,'wx',0o600);
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > (Number(process.env.GLOWHUM_PREVIEW_MAX_BYTES) || 1024*1024*1024)) fail(413,'Video is too large.');
            if (prefix.length < 12) prefix = Buffer.concat([prefix,chunk]).subarray(0,12);
            hash.update(chunk); await handle.writeFile(chunk);
          }
          if (size < 32 || prefix.toString('ascii',4,8) !== 'ftyp') fail(400,'A finished MP4 video is required.');
          await handle.close();
          await fs.rename(tmp,path.join(dir,'preview.mp4'));
          const readyAt = now();
          const preview = {url:`/api/drop/${id}/preview`,sha256:hash.digest('hex'),size,ready_at:readyAt};
          const receipt = await read(root,id).then(({receipt:current}) => current);
          const pipeline = pipelineFor(receipt, state);
          const earlierStepsComplete = pipeline.stages.slice(1, -1).every((stage) => stage.status === 'complete');
          const artifact = {name:'preview.mp4',path:'preview.mp4',size,sha256:preview.sha256};
          const nextPipeline = {
            ...pipeline,
            stages: pipeline.stages.map((stage) => stage.id === 'episode'
              ? {...stage, status: earlierStepsComplete ? 'complete' : 'received', at:readyAt, artifact}
              : stage),
            activity: [...pipeline.activity, event('episode', earlierStepsComplete ? 'Episode saved.' : 'Episode file received. Earlier steps are still waiting.', readyAt, artifact)],
          };
          await save(dir,{...state,status:'ready',preview,pipeline:nextPipeline});
        } finally { await handle.close().catch(()=>{}); await fs.rm(tmp,{force:true}); }
      } else if (action === 'artifact') {
        const stageId = String(req.headers['x-pipeline-stage'] || '');
        if (!pipelineStagePattern.test(stageId) || stageId === 'report') fail(400, 'Choose script, shots, voice or episode.');
        const receipt = await read(root,id).then(({receipt:current}) => current);
        const pipeline = pipelineFor(receipt, state);
        const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
        if (!pipeline.stages.slice(1, index).every((stage) => stage.status === 'complete')) fail(409, 'Finish the earlier pipeline step first.');
        const artifact = await saveStageArtifact(dir, req, stageId);
        await save(dir,recordStage(state, receipt, stageId, artifact));
      } else if (action === 'complete') {
        const input = await body(req);
        if (state.status === 'published' && input.video_id === state.publication.video_id && input.preview_sha256 === state.approved_sha256) return;
        if (state.status !== 'publishing') fail(409,'No publication is in progress.');
        if (!/^[\w-]{11}$/.test(input.video_id || '') || input.channel_id !== state.destination.channel_id || input.visibility !== 'unlisted' || !shaPattern.test(input.preview_sha256 || '') || input.preview_sha256 !== state.approved_sha256 || input.verified !== true) fail(400,'A confirmed publication matching the approved video and destination is required.');
        const publishedAt = now();
        const publication = {service:'YouTube',video_id:input.video_id,url:`https://www.youtube.com/watch?v=${input.video_id}`,channel_id:input.channel_id,visibility:'unlisted',preview_sha256:input.preview_sha256,published_at:publishedAt};
        const publishedReceipt = await read(root,id).then(({receipt:current}) => current);
        await save(dir,appendActivity({...state,status:'published',publication}, publishedReceipt, 'episode', 'Episode published.', publishedAt, publication));
        // Fire-and-forget: the customer's copy of this order already has a real email address
        // from Stripe checkout (jobFromCheckoutSession). Never let a slow/failed send turn a
        // successful publish into an error -- the order is already durably 'published'.
        if (publishedReceipt?.email) {
          const { subject, text, html } = orderReadyEmail({ orderId: publishedReceipt.stripe_order_id || id, topic: publishedReceipt.topic, videoUrl: publication.url });
          sendMail({ to: publishedReceipt.email, subject, text, html }).then((outcome) => {
            if (!outcome.sent) {
              console.error(JSON.stringify({ component: 'mail', event: 'order_ready_email_failed', order_id: id, outcome }));
            }
          });
        }
      } else if (action === 'failed') {
        await body(req);
        if (!['rendering','publishing'].includes(state.status)) fail(409,'This job is no longer running.');
        await save(dir,{...state,status:state.status === 'publishing' ? 'publication_unknown':'failed',message:state.status === 'publishing' ? 'We could not confirm the upload. We will check the destination before trying again.' : 'We could not finish this video. Your report is saved. Please contact support with your receipt.'});
      } else fail(404,'Not found.');
    });
    json(res,200,await publicDrop(root,id));
  } catch(e) { if (!res.headersSent) json(res,Number.isInteger(e.code) ? e.code : 500,{error:Number.isInteger(e.code) ? e.message:'Could not save this step. Check status before trying again.'}); else res.destroy(); }
  return true;
}
