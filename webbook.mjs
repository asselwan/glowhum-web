import fs from 'node:fs/promises';
import path from 'node:path';

const idPattern = /^[a-f0-9]{32}$/;
export async function webBookOrderView(root, orderId) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(root, 'drops', orderId, 'webbook-state.json'), 'utf8'));
    if (state.status === 'published' && idPattern.test(state.book_id)) return { status: 'published', book_url: `${state.base_url}/book/${state.book_id}`, published_at: state.published_at };
    if (state.status === 'failed') return { status: 'failed', book_url: null, published_at: null };
    return { status: 'rendering', book_url: null, published_at: null };
  } catch { return { status: 'paid', book_url: null, published_at: null }; }
}
export async function webBookRoutes(req, res, pathname, { root }) {
  if (pathname === '/book-client.js' && req.method === 'GET') {
    const bytes = await fs.readFile(new URL('./book-client.js', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return true;
  }
  const match = pathname.match(/^\/book\/([a-f0-9]{32})(?:\/(source\.pdf|data\.json|audio-[0-9]+\.mp3))?$/);
  if (!match || req.method !== 'GET') return false;
  const [, id, asset] = match;
  try {
    const folder = id === '00000000000000000000000000000000' ? new URL('./demo/', import.meta.url).pathname : path.join(root, 'books', id);
    const file = asset ? path.join(folder, asset) : new URL('./book.html', import.meta.url);
    const bytes = await fs.readFile(file);
    const type = asset === 'source.pdf' ? 'application/pdf' : asset === 'data.json' ? 'application/json; charset=utf-8' : asset?.endsWith('.mp3') ? 'audio/mpeg' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; media-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
  return true;
}
