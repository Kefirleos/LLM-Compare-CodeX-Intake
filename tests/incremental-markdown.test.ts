import { expect, it } from 'vitest';
import { toHast } from 'mdast-util-to-hast';
import type { Nodes } from 'hast';
import { MarkdownEngine, parseCanonical } from '../apps/web/src/features/markdown/engine';
import type { AstBlock } from '../apps/web/src/features/markdown/engine';

function semantic(node: Nodes, parent = 'root'): unknown {
  if (node.type === 'text') return /^\s*$/.test(node.value) && ['root', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'blockquote'].includes(parent) ? null : node.value;
  if (node.type === 'element') return [node.tagName, node.properties, node.children.map((child) => semantic(child, node.tagName)).filter((child) => child !== null)];
  if (node.type === 'root') return node.children.map((child) => semantic(child)).filter((child) => child !== null);
  return node.type;
}
function assembled(blocks: readonly AstBlock[]) { return blocks.flatMap((block) => semantic(toHast(block.ast)) as unknown[]); }
const fixtures = [
  '# Заголовок\n\nSetext\n---\n\n***\n\nТекст **жирный** и *курсив*, `код`, ~~удалено~~.\n',
  '- one\n  - nested\n\n- loose\n  continuation\n\n  paragraph\n\n1. first\n2. second\n',
  '> quote\n>\n> - list\n>   continued\n\nlazy paragraph\n',
  '```js\nconst x = 1;\n\n[x]: not-a-definition\n````\n\n    indented\n\n    more\n',
  '| A | B |\n| :--- | ---: |\n| **cell** | `x` |\n\n- [x] done\n- [ ] pending\n\nhttps://example.com/a.\n',
  '[a][ref] and [ref] and [ref][] and ![image][ref]\n\nIndependent.\n\n[ref]: https://example.com/a "Title"\n\n[REF]: /ignored\n',
  '[Unicode][  ЛаБеЛ\n  X ]\n\n> [ЛАБЕЛ x]: /first\n\n[лабел x]: /second\n',
  '[a][ref]\n\n- [ref]: /from-list\n\n  list text\n',
  '[a][r]\n\n[r]: /first\n  "multiline title"\n\n[unresolved] [bad](javascript:alert%281%29)\n',
  'a\r\n\r\nb\r\n===\r\n\r\n- x\r\n\tcontinued\r\n',
  '<script>bad()\n\n[x]: /ignored\n</script>\n\n![alt](https://tracking.invalid/x)\n',
  '👋 e\u0301 中文 [escaped\\*][r\\*]\n\n[r\\*]: /url\n',
  '[x]: /url\n    code\n  continuation\n[x]\n\n| --- | --- |\n```\n\tcode\n---\n[x]\n```\n[x]\n',
  '---\n\tcode\n\n- item\n  continuation\n[x]\n[x]: /url\n| --- | --- |\na | b\n| --- | --- |\n\n| --- | --- |\n',
];

it.each(fixtures)('matches canonical GFM at every append boundary: %s', (source) => {
  const engine = new MarkdownEngine();
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    expect(assembled(engine.update(prefix).blocks), `prefix ${end}: ${JSON.stringify(prefix)}`).toEqual(semantic(toHast(parseCanonical(prefix))));
  }
}, 20_000);

it('matches canonical output for every two-part split and random partitions', () => {
  for (const source of fixtures) for (let split = 0; split <= source.length; split++) {
    const engine = new MarkdownEngine();
    engine.update(source.slice(0, split));
    expect(assembled(engine.update(source).blocks)).toEqual(semantic(toHast(parseCanonical(source))));
  }
  let seed = 42;
  const source = fixtures.join('\n\n');
  for (let trial = 0; trial < 20; trial++) {
    const engine = new MarkdownEngine();
    let end = 0;
    while (end < source.length) { seed = (seed * 1664525 + 1013904223) >>> 0; end = Math.min(source.length, end + 1 + seed % 53); engine.update(source.slice(0, end)); }
    expect(assembled(engine.update(source).blocks)).toEqual(semantic(toHast(parseCanonical(source))));
  }
}, 20_000);

it('reuses real syntax subtrees and unchanged AST objects', () => {
  const engine = new MarkdownEngine();
  const source = Array.from({ length: 100 }, (_, i) => `Paragraph ${i} with stable text.`).join('\n\n') + '\n\n';
  const before = engine.update(source);
  const after = engine.update(source + 'New tail');
  expect(after.stats.reusedSyntaxBlocks).toBeGreaterThan(90);
  expect(after.stats.reusedAstBlocks).toBe(100);
  expect(after.stats.parsedAstChars).toBe('New tail'.length);
  expect(after.blocks[0]).toBe(before.blocks[0]);
  expect(after.blocks[99]).toBe(before.blocks[99]);
});

it('matches a deterministic corpus of mixed block boundaries', () => {
  const lines = ['text', '- item', '  continuation', '> quote', '```', '    code', '[x]: /url', '[x]', '---', '# heading', 'a | b', '| --- | --- |', '', '\tcode'];
  let seed = 123;
  for (let trial = 0; trial < 200; trial++) {
    let source = '';
    for (let line = 0; line < 12; line++) { seed = (seed * 1664525 + 1013904223) >>> 0; source += lines[seed % lines.length] + '\n'; }
    const engine = new MarkdownEngine();
    for (let end = 7; end < source.length; end += 13) engine.update(source.slice(0, end));
    expect(assembled(engine.update(source).blocks), JSON.stringify(source)).toEqual(semantic(toHast(parseCanonical(source))));
  }
}, 20_000);

it('invalidates only affected reference blocks and keeps first definition precedence', () => {
  const engine = new MarkdownEngine();
  const source = '[link][ref]\n\nIndependent.\n\n[other][other]\n\n';
  const before = engine.update(source);
  const after = engine.update(source + '[REF]: /first\n\n');
  expect(after.blocks[0]).not.toBe(before.blocks[0]);
  expect(after.blocks[1]).toBe(before.blocks[1]);
  expect(after.blocks[2]).toBe(before.blocks[2]);
  const duplicate = engine.update(source + '[REF]: /first\n\n[ref]: /ignored');
  expect(duplicate.blocks[0]).toBe(after.blocks[0]);
  expect(assembled(duplicate.blocks)).toEqual(semantic(toHast(parseCanonical(source + '[REF]: /first\n\n[ref]: /ignored'))));
});
