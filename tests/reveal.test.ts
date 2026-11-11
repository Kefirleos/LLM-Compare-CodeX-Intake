import { expect, it } from 'vitest';
import { RevealDocument, RevealScheduler } from '../apps/web/src/features/markdown/reveal';

function clock() {
  let id = 0; let time = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const scheduler = new RevealScheduler((callback) => { frames.set(++id, callback); return id; }, (token) => { frames.delete(token); });
  return { scheduler, frames, tick() { const next = frames.entries().next().value; if (next) { frames.delete(next[0]); next[1](time += 32); } }, drain() { let count = 0; while (frames.size && count++ < 100) this.tick(); expect(frames.size).toBe(0); return count; } };
}

it('reveals complete words progressively and holds an incomplete tail', () => {
  const c = clock(); const doc = new RevealDocument(c.scheduler);
  const leaf = doc.leaf(0, 22, 'one two three four par', false); leaf.subscribe(() => {});
  expect(leaf.snapshot()).toBe(''); c.tick(); expect(leaf.snapshot()).toBe('one ');
  c.drain(); expect(leaf.snapshot()).toBe('one two three four ');
  doc.leaf(0, 29, 'one two three four partially ', true); c.drain();
  expect(leaf.snapshot()).toBe('one two three four partially '); doc.dispose();
});

it('keeps whitespace, CJK, combining marks and a split emoji exact', () => {
  const c = clock(); const doc = new RevealDocument(c.scheduler);
  const leaf = doc.leaf(0, 2, '👩', false); leaf.subscribe(() => {}); c.drain(); expect(leaf.snapshot()).toBe('');
  const text = '👩‍💻 e\u0301 中文  \nnext\tword'; doc.leaf(0, text.length, text, true); c.drain();
  expect(leaf.snapshot()).toBe(text); doc.dispose();
});

it('does not reanimate already shown source when Markdown syntax changes', () => {
  const c = clock(); const doc = new RevealDocument(c.scheduler);
  const old = doc.leaf(0, 6, '**bold', true); const unsubscribe = old.subscribe(() => {}); c.drain(); unsubscribe();
  const converted = doc.leaf(2, 6, 'bold', true); expect(converted.snapshot()).toBe('bold'); doc.dispose();
});

it('shares one RAF across four independent answers', () => {
  const c = clock(); const docs = Array.from({ length: 4 }, () => new RevealDocument(c.scheduler));
  const leaves = docs.map((doc) => { const leaf = doc.leaf(0, 16, 'one two three end', true); leaf.subscribe(() => {}); return leaf; });
  expect(c.frames.size).toBe(1); c.tick(); expect(c.frames.size).toBe(1);
  expect(leaves.every((leaf) => leaf.snapshot() === 'one ')).toBe(true);
  docs.forEach((doc) => doc.finish()); expect(c.frames.size).toBe(0); expect(leaves.every((leaf) => leaf.snapshot() === 'one two three end')).toBe(true);
});

it('flushes every received character at terminal, Stop, hidden tab or reduced motion', () => {
  for (const terminal of [true, false]) {
    const c = clock(); const doc = new RevealDocument(c.scheduler); const text = 'first unfinished';
    const leaf = doc.leaf(0, text.length, text, false); leaf.subscribe(() => {});
    if (terminal) doc.finish(); else doc.setImmediate(true);
    expect(leaf.snapshot()).toBe(text); expect(c.frames.size).toBe(0);
    doc.leaf(0, text.length + 1, text + '!', true); expect(leaf.snapshot()).toBe(text + '!'); doc.dispose();
  }
});

it('bounds catch-up work and releases queued frames on disposal', () => {
  const c = clock(); const doc = new RevealDocument(c.scheduler); const text = 'word '.repeat(200);
  const leaf = doc.leaf(0, text.length, text, true); leaf.subscribe(() => {});
  expect(c.drain()).toBeLessThan(30); expect(leaf.snapshot()).toBe(text);
  const huge = 'x'.repeat(8193); const large = doc.leaf(2000, 2000 + huge.length, huge, false); expect(large.snapshot()).toBe(huge);
  large.subscribe(() => {}); doc.dispose(); expect(c.frames.size).toBe(0);
});

it('releases replaced text leaves without resetting the source cursor', () => {
  const c = clock(); const doc = new RevealDocument(c.scheduler);
  for (let index = 0; index < 100; index++) {
    const leaf = doc.leaf(index * 10, index * 10 + 5, 'word ', true); const unsubscribe = leaf.subscribe(() => {});
    c.drain(); unsubscribe(); expect(doc.retainedLeafCount).toBe(0);
  }
  const alreadySeen = doc.leaf(0, 4, 'word', true); expect(alreadySeen.snapshot()).toBe('word'); doc.dispose(); expect(c.frames.size).toBe(0);
});
