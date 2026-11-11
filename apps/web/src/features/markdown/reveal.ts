type FrameRequest = (callback: FrameRequestCallback) => number;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : undefined;
interface Segment { from: number; to: number }

/** Shared by all answers: no timer or RAF per word. */
export class RevealScheduler {
  private documents = new Set<RevealDocument>();
  private frame: number | undefined;
  constructor(private readonly request: FrameRequest, private readonly cancel: (id: number) => void) {}
  enqueue(document: RevealDocument) {
    this.documents.add(document);
    this.frame ??= this.request((time) => this.tick(time));
  }
  remove(document: RevealDocument) {
    this.documents.delete(document);
    if (!this.documents.size && this.frame !== undefined) { this.cancel(this.frame); this.frame = undefined; }
  }
  private tick(time: number) {
    this.frame = undefined;
    for (const document of this.documents) if (!document.advance(time)) this.documents.delete(document);
    if (this.documents.size && this.frame === undefined) this.frame = this.request((next) => this.tick(next));
  }
}
export const browserRevealScheduler = new RevealScheduler((callback) => requestAnimationFrame(callback), (id) => cancelAnimationFrame(id));

export class RevealDocument {
  cursor = 0;
  immediate: boolean;
  finished: boolean;
  private active = true;
  private leaves = new Map<number, RevealLeaf>();
  private lastFrame = -Infinity;
  constructor(private readonly scheduler: RevealScheduler, immediate = false, finalized = false) { this.immediate = immediate || !segmenter; this.finished = finalized; }
  get retainedLeafCount() { return this.leaves.size; }
  listen(leaf: RevealLeaf) { this.leaves.set(leaf.start, leaf); this.touch(); }
  forget(leaf: RevealLeaf) {
    if (this.leaves.get(leaf.start) === leaf) this.leaves.delete(leaf.start);
    if (!this.leaves.size) this.scheduler.remove(this);
  }
  connect() { this.active = true; this.touch(); }
  leaf(start: number, end: number, text: string, sealed: boolean) {
    let leaf = this.leaves.get(start);
    if (!leaf) { leaf = new RevealLeaf(this, start); this.leaves.set(start, leaf); }
    leaf.update(end, text, sealed);
    return leaf;
  }
  touch() { if (this.active && !this.immediate && !this.finished) this.scheduler.enqueue(this); }
  setImmediate(value: boolean) {
    this.immediate = value || !segmenter;
    if (this.immediate) this.flush(); else this.touch();
  }
  finish() { this.finished = true; this.flush(); }
  dispose() { this.active = false; this.scheduler.remove(this); this.leaves.forEach((leaf) => leaf.clear()); this.leaves.clear(); }
  private flush() {
    for (const leaf of this.leaves.values()) this.cursor = Math.max(this.cursor, leaf.end);
    this.leaves.forEach((leaf) => leaf.flush()); this.scheduler.remove(this);
  }
  advance(time: number): boolean {
    if (!this.active || this.immediate || this.finished) return false;
    const leaves = [...this.leaves.values()].filter((leaf) => leaf.listening).sort((a, b) => a.start - b.start);
    leaves.forEach((leaf) => leaf.syncCursor());
    const backlog = leaves.reduce((sum, leaf) => sum + leaf.pending, 0);
    if (!backlog) return false;
    if (time - this.lastFrame < 24) return true;
    this.lastFrame = time;
    let budget = Math.max(2, Math.ceil(backlog / 4));
    for (const leaf of leaves) { const spent = leaf.reveal(budget); budget -= spent; if (budget <= 0) break; }
    return leaves.some((leaf) => leaf.pending > 0);
  }
}

export class RevealLeaf {
  end = 0;
  private text = '';
  private visible = 0;
  private segments: Segment[] = [];
  private sealed = false;
  private listeners = new Set<() => void>();
  constructor(private readonly document: RevealDocument, readonly start: number) {}
  get listening() { return this.listeners.size > 0; }
  get pending() { return this.segments.filter((segment, index) => segment.to > this.visible && (this.sealed || index < this.segments.length - 1)).length; }
  snapshot = () => this.text.slice(0, this.visible);
  subscribe = (listener: () => void) => { this.listeners.add(listener); this.document.listen(this); return () => { this.listeners.delete(listener); if (!this.listeners.size) this.document.forget(this); }; };
  clear() { this.listeners.clear(); }
  update(end: number, text: string, sealed: boolean) {
    if (this.end === end && this.text === text && this.sealed === sealed) return;
    const append = text.startsWith(this.text);
    this.end = end; this.sealed = sealed;
    if (this.document.finished || this.document.immediate || text.length > 8192 || !segmenter) {
      this.text = text; this.visible = text.length; this.segments = []; this.document.cursor = Math.max(this.document.cursor, end); if (this.listening) this.document.touch(); return;
    }
    const from = append ? this.segments.at(-1)?.from ?? 0 : 0;
    this.segments = [...this.segments.filter((segment) => segment.to <= from), ...[...segmenter.segment(text.slice(from))].map((segment) => ({ from: from + segment.index, to: from + segment.index + segment.segment.length }))];
    if (!append) this.visible = this.document.cursor >= end ? text.length : 0;
    this.text = text;
    this.syncCursor(false);
    if (this.listening) this.document.touch();
  }
  private sourceEnd(chars: number) { return this.start + Math.ceil((this.end - this.start) * chars / Math.max(1, this.text.length)); }
  syncCursor(notify = true) {
    const before = this.visible;
    for (const segment of this.segments) if (this.sourceEnd(segment.to) <= this.document.cursor) this.visible = Math.max(this.visible, segment.to);
    if (notify && before !== this.visible) this.listeners.forEach((listener) => listener());
  }
  reveal(budget: number): number {
    let spent = 0;
    for (let index = 0; index < this.segments.length && spent < budget; index++) {
      const segment = this.segments[index]!;
      if (segment.to <= this.visible || (!this.sealed && index === this.segments.length - 1)) continue;
      this.visible = segment.to; this.document.cursor = Math.max(this.document.cursor, this.sourceEnd(this.visible)); spent++;
    }
    if (spent) this.listeners.forEach((listener) => listener());
    return spent;
  }
  flush() { const changed = this.visible !== this.text.length; this.visible = this.text.length; if (changed) this.listeners.forEach((listener) => listener()); }
}
