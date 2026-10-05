import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBook, pronunciation } from './run-webbook.mjs';
import { guideBook } from '../book-guide.mjs';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('demo Web Book keeps every quiz answer tied to its PDF passage',async()=>{
 const pdf=await fs.readFile(path.join(repo,'demo/source.pdf'));
 const book=await buildBook(pdf,"Alice's Adventures in Wonderland");
 assert.equal(book.source_pages,20);
 assert.ok(book.chapters.length>=5);
 for(const chapter of book.chapters){
  assert.equal(chapter.quiz.source_page,chapter.passage.page);
  assert.equal(chapter.quiz.source_text,chapter.passage.text);
  assert.equal(chapter.quiz.options[chapter.quiz.answer],chapter.passage.text.slice(0,125));
  for(let i=0;i<chapter.quiz.options.length;i++)assert.equal(chapter.quiz.options[i],chapter.quiz.option_sources[i].text.slice(0,125));
  assert.ok(chapter.narration.length>80);
  assert.ok(!/https?:\/\//.test(chapter.narration));
  assert.equal(chapter.source_url,'https://www.gutenberg.org/cache/epub/11/pg11.txt');
  assert.ok(!/https?:\/\/[^\s]+ or /.test(chapter.narration));
 }
 assert.ok(!book.chapters[1].passage.text.endsWith('which was l'));
 assert.ok(!book.chapters[2].passage.text.endsWith('hap'));
});

test('pronunciation changes fractions but preserves URL and citation slashes',()=>{
 assert.equal(pronunciation('x/y and 3/4; and/or; https://www.gutenberg.org/cache/epub/11/pg11.txt'),
  'x or y and 3 or 4; and/or; https://www.gutenberg.org/cache/epub/11/pg11.txt');
});

test('reader guide locates Dodo passage without presenting word overlap as verification',async()=>{
 const pdf=await fs.readFile(path.join(repo,'demo/source.pdf'));
 const book=await buildBook(pdf,"Alice's Adventures in Wonderland");
 const positive=guideBook(book,'Where does Alice meet the Dodo birds near the pool?');
 assert.equal(positive.found,true);
 assert.equal(positive.page,13);
 assert.deepEqual(positive.matched_terms,['alice','dodo','birds','pool']);
 assert.equal(positive.claim_verified,false);
 assert.equal(positive.match_type,'word_overlap');
 assert.match(positive.message,/does not verify your question or its claim/i);

 const mars=guideBook(book,'Do Dodo birds fly to Mars from the pool?');
 assert.equal(mars.found,true);
 assert.equal(mars.page,13);
 assert.deepEqual(mars.matched_terms,['dodo','birds','pool']);
 assert.equal(mars.claim_verified,false);
 assert.equal(mars.match_type,'word_overlap');
 assert.match(mars.message,/does not verify your question or its claim/i);
 assert.doesNotMatch(mars.message,/looks relevant|answers your question/i);

 const unrelated=guideBook(book,'How does the book explain quantum mechanics?');
 assert.equal(unrelated.found,false);
});

test('Web Book checkout chooses its own Stripe Price and requires a PDF URL',async()=>{
 const {createServer}=await import('node:http');const {spawn}=await import('node:child_process');
 const calls=[];const fake=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);calls.push(new URLSearchParams(Buffer.concat(parts).toString()));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'cs_test_webbook_1',url:'https://checkout.stripe.test/book'}))});
 await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));const port=20000+Math.floor(Math.random()*30000);
 const child=spawn(process.execPath,[path.join(repo,'server.mjs')],{env:{...process.env,NODE_ENV:'test',PORT:String(port),STRIPE_SECRET_KEY:'sk_test_webbook',STRIPE_PRICE_ID:'price_test_episode',STRIPE_WEB_BOOK_PRICE_ID:'price_test_webbook',GLOWHUM_WEB_BOOK_WORKER_ENABLED:'true',GLOWHUM_WEB_BOOK_PRICE_APPROVED:'true',GLOWHUM_WEB_BOOK_PRICE_AED:'49',STRIPE_API_BASE_URL:`http://127.0.0.1:${fake.address().port}`,PUBLIC_BASE_URL:'https://glowhum.test'},stdio:'ignore'});
 try{
  let ready=false;for(let i=0;i<50;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/web-book-config`);if(r.ok){ready=true;assert.deepEqual(await r.json(),{price_aed:49,checkout_ready:true});break}}catch{}await new Promise(r=>setTimeout(r,100))}assert.ok(ready);
  const post=body=>fetch(`http://127.0.0.1:${port}/api/checkout`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({product:'web_book',email:'reader@example.com',topic:'Alice'})).status,400);
  const response=await post({product:'web_book',email:'reader@example.com',topic:'Alice',report_url:'https://example.org/alice.pdf'});assert.equal(response.status,201);
  assert.equal(calls.length,1);assert.equal(calls[0].get('line_items[0][price]'),'price_test_webbook');assert.equal(calls[0].get('metadata[glowhum_product]'),'glowhum_web_book_v1');
  const demo=await fetch(`http://127.0.0.1:${port}/book/00000000000000000000000000000000`);assert.equal(demo.status,200);assert.match(await demo.text(),/Interactive Web Book/);
 }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));await new Promise(resolve=>fake.close(resolve))}
});

test('clinical review gate distinguishes a clinical title from literary medicine mentions',async()=>{
 const alice=await fs.readFile(path.join(repo,'demo/source.pdf'));const frank=await fs.readFile(path.join(repo,'trials/frankenstein.pdf'));assert.equal((await buildBook(alice,'Clinical protocol')).medical,true);assert.equal((await buildBook(frank,'Frankenstein')).medical,false);
});
