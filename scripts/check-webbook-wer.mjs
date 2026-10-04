#!/usr/bin/env node
// Measure one newly generated chapter with the same Piper/Whisper WER proxy.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.env.GLOWHUM_DROPS_DIR || '/data/glowhum-drops';
const logPath = process.env.GLOWHUM_RSI_LOG_PATH || path.join(root, '.ainur/review/glowhum-webbook/rsi-log.jsonl');
const threshold = Number(process.env.GLOWHUM_RSI_WER_THRESHOLD || '0.15');
const model = process.env.GLOWHUM_RSI_PIPER_MODEL || '/tmp/glowhum-tts-model/en_US-libritts-high.onnx';
const config = process.env.GLOWHUM_RSI_PIPER_CONFIG || `${model}.json`;
const piper = process.env.GLOWHUM_RSI_PIPER_BIN || '/tmp/glowhum-tts-venv/bin/piper';
const whisper = process.env.GLOWHUM_RSI_WHISPER_URL || 'http://127.0.0.1:9002/asr?output=json&language=en';
const seed = new URL('../.ainur/review/glowhum-webbook/rsi-log.jsonl', import.meta.url);
const evidenceRoot = path.join(path.dirname(logPath), 'retained-evidence');
const maxRetainedCases = 10;

async function append(record) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  try { await fs.copyFile(seed, logPath, fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`);
}

async function retainEvidence(temp, record) {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const prefix = `${record.checked_at.replace(/\D/g, '')}-${record.book_id}-${record.chapter_index}-`;
  const destination = await fs.mkdtemp(path.join(evidenceRoot, prefix));
  try {
    for (const name of ['sample.txt', 'sample.mp3', 'sample.asr.json']) {
      await fs.copyFile(path.join(temp, name), path.join(destination, name));
    }
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
  const cases = (await fs.readdir(evidenceRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^\d{17}-[a-f0-9]{32}-\d+-/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  for (const oldCase of cases.slice(0, -maxRetainedCases)) {
    await fs.rm(path.join(evidenceRoot, oldCase), { recursive: true, force: true });
  }
  return destination;
}

export async function checkBookWer(bookId) {
  const checkedAt = new Date().toISOString();
  const record = { loop: 'narration-text-quality', book_id: bookId, checked_at: checkedAt, metric: 'WER', threshold, cost_aed: 0 };
  let temp;
  try {
    if (!/^[a-f0-9]{32}$/.test(bookId)) throw Error('Invalid book ID');
    if (!Number.isFinite(threshold) || threshold < 0) throw Error('Invalid WER threshold');
    const book = JSON.parse(await fs.readFile(path.join(root, 'books', bookId, 'data.json'), 'utf8'));
    const chapterIndex = book.chapters.findIndex(chapter => typeof chapter.narration === 'string' && chapter.narration.trim());
    if (chapterIndex < 0) throw Error('No narration sample');
    record.chapter_index = chapterIndex;
    record.source_sha256 = book.source_sha256;
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'glowhum-rsi-'));
    const reference = path.join(temp, 'sample.txt');
    const wav = path.join(temp, 'sample.wav');
    const mp3 = path.join(temp, 'sample.mp3');
    const asrFile = path.join(temp, 'sample.asr.json');
    await fs.writeFile(reference, `${book.chapters[chapterIndex].narration}\n`);
    await run(piper, ['-m', model, '-c', config, '-i', reference, '-f', wav], { timeout: 300000, env: { ...process.env, OMP_NUM_THREADS: '4' } });
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-q:a', '4', mp3], { timeout: 30000 });
    const form = new FormData();
    form.set('audio_file', new Blob([await fs.readFile(mp3)], { type: 'audio/mpeg' }), 'sample.mp3');
    const response = await fetch(whisper, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`Whisper HTTP ${response.status}`);
    await fs.writeFile(asrFile, await response.text());
    const { stdout } = await run(process.env.GLOWHUM_RSI_PYTHON_BIN || 'python3', [new URL('./score_asr.py', import.meta.url).pathname, reference, asrFile], { timeout: 30000 });
    const result = JSON.parse(stdout);
    Object.assign(record, { status: 'measured', ...result, flagged: result.wer > threshold });
    if (record.flagged) {
      try { record.evidence_dir = await retainEvidence(temp, record); }
      catch (error) { record.evidence_error = error.message; }
    }
  } catch (error) {
    Object.assign(record, { status: 'measurement_error', flagged: true, error: error.message });
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
  await append(record);
  if (record.flagged) console.warn(`Glowhum narration WER alert for ${bookId}: ${record.status === 'measured' ? record.wer : record.error}`);
  return record;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  checkBookWer(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}
