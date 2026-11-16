import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';

const assets = new URL('../apps/web/dist/assets/', import.meta.url);
const bundles = (await readdir(assets)).filter((file) => /^markdown\.worker-.*\.js$/.test(file));
assert.equal(bundles.length, 1, 'Build the web app with exactly one worker artifact before checking it.');
const name = bundles[0];
const bootstrap = `
  const { parentPort, workerData } = require('node:worker_threads');
  globalThis.self = { postMessage: (reply) => parentPort.postMessage(reply) };
  import(workerData.url).then(() => {
    parentPort.on('message', (data) => self.onmessage({ data }));
    parentPort.postMessage({ ready: true });
  }).catch((error) => { throw error; });
`;
function nextMessage(worker, send) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
    const message = (reply) => { cleanup(); resolve(reply); };
    const error = (cause) => { cleanup(); reject(cause); };
    const exit = (code) => error(new Error(`Worker exited before replying: ${code}`));
    const timer = setTimeout(() => error(new Error('Worker reply timed out')), 20_000);
    worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
    if (send) worker.postMessage(send);
  });
}
function semantic(node, parent = 'root') {
  if (node.type === 'text') return /^\s*$/.test(node.value) && ['root', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'blockquote'].includes(parent) ? null : node.value;
  if (node.type === 'element') return [node.tagName, node.properties, node.children.map((child) => semantic(child, node.tagName)).filter((child) => child !== null)];
  if (node.type === 'root') return node.children.map((child) => semantic(child)).filter((child) => child !== null);
  return node.type;
}
const workers = [];
const samples = [];
let ticks = 0; let maxTickDelayMs = 0; let lastTick = performance.now();
const heartbeat = setInterval(() => { const now = performance.now(); maxTickDelayMs = Math.max(maxTickDelayMs, now - lastTick); lastTick = now; ticks++; }, 10);
try {
  await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const worker = new Worker(bootstrap, { eval: true, workerData: { url: new URL(name, assets).href } });
    workers.push(worker);
    assert.deepEqual(await nextMessage(worker), { ready: true });
    const prefix = Array.from({ length: 200 }, (_, i) => `Stable paragraph ${i}: Unicode 👋, &copy; and **formatting**.`).join('\n\n') + '\n\n';
    const fenced = index % 2 === 0;
    const content = (fenced ? 'x' : 'word ').repeat(65536).slice(0, 65536);
    const sources = [8192, 16384, 65536].map((size) => prefix + (fenced ? '```text\n' : '') + content.slice(0, size));
    sources.push(sources.at(-1) + (fenced ? '\n```' : '') + '\n\nFinal');
    let version = 0;
    let lookup = new Map();
    for (const text of sources) {
      const start = performance.now();
      const reply = await nextMessage(worker, { documentId: `attempt-${index}`, epoch: 1, baseVersion: version, version: version + 1, text });
      const roundTripMs = performance.now() - start;
      assert.equal(reply.error, undefined);
      assert.equal(reply.documentId, `attempt-${index}`); assert.equal(reply.epoch, 1);
      assert.equal(reply.baseVersion, version); assert.equal(reply.version, version + 1);
      if (version) { assert(reply.stats.reusedSyntaxBlocks >= 190); assert(reply.stats.reusedAstBlocks >= 190); assert(reply.stats.parsedAstChars < text.length); }
      for (const block of reply.changed) lookup.set(block.id, block);
      const blocks = reply.order.map((id) => lookup.get(id));
      assert(blocks.every(Boolean));
      const expected = semantic(toHast(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })));
      assert.deepEqual(blocks.flatMap((block) => semantic(toHast(block.ast))), expected);
      samples.push({ worker: index, version: ++version, chars: text.length, roundTripMs, ...reply.stats });
      lookup = new Map(blocks.map((block) => [block.id, block]));
    }
    const replacement = { documentId: `restored-${index}`, epoch: 0, baseVersion: 0, version: 1, text: '# Another answer\n\nIndependent.' };
    const restarted = await nextMessage(worker, replacement);
    assert.equal(restarted.error, undefined);
    assert.equal(restarted.documentId, replacement.documentId);
    assert.deepEqual(restarted.changed.map((block) => block.id), restarted.order);
    assert.deepEqual(restarted.changed.flatMap((block) => semantic(toHast(block.ast))),
      semantic(toHast(fromMarkdown(replacement.text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))));
  }));
  assert(ticks > 0, 'Main event loop must keep running while worker threads parse.');
  await writeFile(new URL('../markdown-performance.log', import.meta.url), JSON.stringify({ runtime: process.version, ticks, maxHarnessTickDelayMs: maxTickDelayMs, canonicalChecksOnMainThread: true, samples }, null, 2) + '\n');
  console.log(`Worker OK: 4 threads, ${samples.length} snapshots; canonical output and reuse verified. Details: markdown-performance.log`);
} finally {
  clearInterval(heartbeat);
  await Promise.all(workers.map((worker) => worker.terminate()));
}
