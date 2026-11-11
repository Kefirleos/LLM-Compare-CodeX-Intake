import { TreeFragment } from '@lezer/common';
import type { SyntaxNode, Tree, Input } from '@lezer/common';
import { parser, GFM } from '@lezer/markdown';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { normalizeIdentifier } from 'micromark-util-normalize-identifier';
import type { Definition, Root, Nodes } from 'mdast';

const markdownParser = parser.configure(GFM);
export const parseCanonical = (source: string): Root => fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
export interface AstBlock { id: string; from: number; to: number; kind: string; ast: Root; prefixLength: number; trailingWhitespace: boolean }
export interface ParseStats { syntaxReadChars: number; reusedSyntaxBlocks: number; parsedAstChars: number; parsedAstBlocks: number; reusedAstBlocks: number; totalBlocks: number }
export interface ParsedDocument { blocks: readonly AstBlock[]; stats: ParseStats }
interface BlockRecord { block: AstBlock; source: string; baseAst: Root; syntax: Tree; dependencies: Set<string>; definitions: Definition[]; context: string }

function definitionsIn(root: Root): Definition[] {
  const found: Definition[] = [];
  const visit = (node: Nodes) => {
    if (node.type === 'definition') found.push(node);
    if ('children' in node) node.children.forEach(visit);
  };
  visit(root);
  return found;
}

// Lezer recognizes potential references even before their definitions exist.
// This index controls invalidation only; CommonMark determines whether they resolve.
function dependenciesIn(node: SyntaxNode, source: string): Set<string> {
  const labels = new Set<string>();
  const cursor = node.cursor();
  do {
    if (cursor.name !== 'Link' && cursor.name !== 'Image') continue;
    const link = cursor.node;
    if (link.getChild('URL')) continue;
    const label = link.getChild('LinkLabel');
    const marks = link.getChildren('LinkMark');
    const open = marks[0];
    const close = marks[1];
    const raw = label && label.to - label.from > 2 ? source.slice(label.from + 1, label.to - 1)
      : open && close ? source.slice(open.to, close.from) : '';
    if (raw) labels.add(normalizeIdentifier(raw));
  } while (cursor.next());
  return labels;
}

/** One append-only syntax tree and block AST per answer, independent of React. */
export class MarkdownEngine {
  private source = '';
  private tree: Tree | undefined;
  private records: BlockRecord[] = [];

  update(source: string): ParsedDocument {
    const stats: ParseStats = { syntaxReadChars: 0, reusedSyntaxBlocks: 0, parsedAstChars: 0, parsedAstBlocks: 0, reusedAstBlocks: 0, totalBlocks: 0 };
    const append = source.startsWith(this.source);
    const fragments = this.tree && append ? TreeFragment.applyChanges(TreeFragment.addTree(this.tree), [
      { fromA: this.source.length, toA: this.source.length, fromB: this.source.length, toB: source.length },
    ], 0) : [];
    const input: Input = {
      length: source.length, lineChunks: false,
      chunk(from) { const value = source.slice(from, from + 4096); stats.syntaxReadChars += value.length; return value; },
      read(from, to) { stats.syntaxReadChars += to - from; return source.slice(from, to); },
    };
    const tree = markdownParser.parse(input, fragments);
    const previous = new Map((append ? this.records : []).map((record) => [record.block.id, record]));
    const records: BlockRecord[] = [];
    const blockStart = (position: number) => {
      const lineStart = Math.max(source.lastIndexOf('\n', position - 1), source.lastIndexOf('\r', position - 1)) + 1;
      return source.slice(lineStart, position).trim() ? position : lineStart;
    };
    for (let node: SyntaxNode | null = tree.topNode.firstChild; node;) {
      const first: SyntaxNode = node;
      let last: SyntaxNode = first;
      const members = [first];
      // Keep adjacent syntax blocks in one canonical context group. Definitions
      // and lazy list continuations can otherwise change a following block's meaning.
      while (last.nextSibling) {
        const next: SyntaxNode = last.nextSibling;
        const gap = source.slice(last.to, blockStart(next.from)).replace(/\r\n?/g, '\n');
        // Canonical parsing carries indented-code context into the next block,
        // including an empty list marker after a blank line.
        if (/\n[ \t]*\n/.test(gap) && last.name !== 'CodeBlock') break;
        members.push(next); last = next;
      }
      // Indented code starts after its first indentation in Lezer's tree.
      const from = blockStart(first.from);
      const to = last.nextSibling ? blockStart(last.nextSibling.from) : source.length;
      const id = `${from}:${first.name}`;
      const raw = source.slice(from, to);
      const old = previous.get(id);
      const syntax = first.toTree();
      node = last.nextSibling;
      if (old?.syntax === syntax) stats.reusedSyntaxBlocks++;
      if (old?.source === raw) { records.push(old.syntax === syntax ? old : { ...old, syntax }); continue; }
      const baseAst = parseCanonical(raw);
      stats.parsedAstChars += raw.length;
      stats.parsedAstBlocks++;
      records.push({ block: { id, from, to, kind: first.name, ast: baseAst, prefixLength: 0, trailingWhitespace: /\s$/.test(raw) }, source: raw,
        syntax, baseAst, dependencies: new Set(members.flatMap((member) => [...dependenciesIn(member, source)])), definitions: definitionsIn(baseAst), context: '' });
    }
    // Definition precedence is global and first-wins, including definitions in containers.
    const definitions = new Map<string, string>();
    for (const record of records) for (const definition of record.definitions) {
      const label = normalizeIdentifier(definition.identifier);
      if (!definitions.has(label)) {
        // A decoded mdast label loses escapes significant to reference matching.
        // Serialize destination/title canonically, preserving the raw normalized identifier.
        const serialized = toMarkdown({ type: 'root', children: [{ ...definition, identifier: 'context', label: 'context' }] }, { extensions: [gfmToMarkdown()] });
        definitions.set(label, `[${definition.identifier}]` + serialized.slice('[context]'.length));
      }
    }
    const blocks = records.map((record, index) => {
      const context = [...record.dependencies].map((label) => definitions.get(label) ?? '').join('');
      const old = previous.get(record.block.id);
      if (old?.source === record.source && old.context === context) { stats.reusedAstBlocks++; return old.block; }
      let ast = record.baseAst;
      if (context) {
        ast = parseCanonical(context + '\n\n' + record.source);
        stats.parsedAstChars += context.length + 2 + record.source.length;
        stats.parsedAstBlocks++;
      }
      const block = { ...record.block, ast, prefixLength: context ? context.length + 2 : 0 };
      records[index] = { ...record, block, context };
      return block;
    });
    this.source = source;
    this.tree = tree;
    this.records = records;
    stats.totalBlocks = blocks.length;
    return { blocks, stats };
  }
}
