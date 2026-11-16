import { toHast } from 'mdast-util-to-hast';
import type { Element, Nodes as HastNode } from 'hast';
import type { Definition, FootnoteDefinition, FootnoteReference, Nodes, Root } from 'mdast';
import type { AstBlock } from './engine';

interface NoteSource {
  block: AstBlock;
  references: FootnoteReference[];
  notes: FootnoteDefinition[];
  links: Definition[];
}

export type FootnoteCalls = ReadonlyMap<FootnoteReference, Element>;
interface FootnotePlan {
  calls: ReadonlyMap<AstBlock, FootnoteCalls>;
  footer?: Element;
}

const empty: FootnotePlan = { calls: new Map() };
const sources = new WeakMap<AstBlock, NoteSource | null>();
const key = (identifier: string) => identifier.toUpperCase();

function noteSource(block: AstBlock): NoteSource | null {
  const cached = sources.get(block);
  if (cached !== undefined) return cached;
  const value: NoteSource = { block, references: [], notes: [], links: [] };
  const visit = (node: Nodes, inNote = false) => {
    if (node.type === 'footnoteDefinition') value.notes.push(node);
    if (node.type === 'definition') value.links.push(node);
    if (node.type === 'footnoteReference' && !inNote) value.references.push(node);
    if ('children' in node) node.children.forEach((child) => visit(child, inNote || node.type === 'footnoteDefinition'));
  };
  visit(block.ast);
  const source = value.references.length || value.notes.length || value.links.length ? value : null;
  sources.set(block, source);
  return source;
}

function withAliases<T extends Nodes>(node: T, aliases: ReadonlyMap<string, string>): T {
  const identifier = node.type === 'footnoteReference' || node.type === 'footnoteDefinition' ? aliases.get(key(node.identifier)) : undefined;
  const updated = identifier === undefined ? node : { ...node, identifier };
  if ('children' in updated) return { ...updated, children: updated.children.map((child) => withAliases(child, aliases)) };
  return updated;
}

function scopeLabel(node: HastNode, id: string) {
  if (node.type === 'element') {
    if (node.properties.dataFootnoteRef === true) node.properties.ariaDescribedBy = [id];
    if (node.properties.id === 'footnote-label') node.properties.id = id;
  }
  if ('children' in node) node.children.forEach((child) => scopeLabel(child, id));
}

/** Only references and definitions enter the document-wide footnote pass. */
export class FootnotePlanner {
  private previous: NoteSource[] = [];
  private plan = empty;

  constructor(private readonly scope: string) {}

  update(blocks: readonly AstBlock[]): FootnotePlan {
    const parts = blocks.map(noteSource).filter((part): part is NoteSource => part !== null);
    if (parts.length === this.previous.length && parts.every((part, index) => part === this.previous[index])) return this.plan;
    this.previous = parts;
    this.plan = this.build(parts);
    return this.plan;
  }

  private build(parts: NoteSource[]): FootnotePlan {
    const aliases = new Map<string, string>();
    const notes: FootnoteDefinition[] = [];
    for (const part of parts) for (const note of part.notes) {
      const label = key(note.identifier);
      if (aliases.has(label)) continue;
      // Numeric aliases keep a repeated label from colliding with another label ending in a number.
      aliases.set(label, String(aliases.size + 1));
      notes.push(note);
    }
    const references = parts.flatMap((part) => part.references.filter((reference) => aliases.has(key(reference.identifier)))
      .map((reference) => ({ block: part.block, reference })));
    if (!references.length) return empty;

    const tree: Root = {
      type: 'root',
      children: [
        { type: 'paragraph', children: references.map(({ reference }) => withAliases(reference, aliases)) },
        ...notes.map((note) => withAliases(note, aliases)),
        ...parts.flatMap((part) => part.links),
      ],
    };
    const result = toHast(tree, {
      clobberPrefix: this.scope,
      footnoteLabel: 'Сноски',
      footnoteLabelProperties: {},
      footnoteBackLabel: (index, repeat) => `К ссылке на сноску ${index + 1}${repeat > 1 ? ` (${repeat})` : ''}`,
    });
    if (result.type !== 'root') return empty;
    const [paragraph] = result.children;
    const footer = result.children.find((node): node is Element => node.type === 'element' && node.properties.dataFootnotes === true);
    if (paragraph?.type !== 'element' || !footer) return empty;
    scopeLabel(result, this.scope + 'label');

    const calls = new Map<AstBlock, Map<FootnoteReference, Element>>();
    references.forEach(({ block, reference }, index) => {
      const element = paragraph.children[index];
      if (element?.type !== 'element') return;
      let blockCalls = calls.get(block);
      if (!blockCalls) { blockCalls = new Map(); calls.set(block, blockCalls); }
      blockCalls.set(reference, element);
    });
    return { calls, footer };
  }
}
