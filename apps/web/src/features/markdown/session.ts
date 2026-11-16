import { MarkdownEngine } from './engine';
import type { AstBlock, ParseStats } from './engine';

export interface ParseRequest { documentId: string; epoch: number; baseVersion: number; version: number; text: string }
export interface AstPatch { documentId: string; epoch: number; baseVersion: number; version: number; changed: AstBlock[]; order: string[]; stats: ParseStats }
export type WorkerReply = AstPatch | (Omit<ParseRequest, 'text'> & { error: string });
export interface ParserPort {
  postMessage(request: ParseRequest): void;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/** One in-flight snapshot. A useful older patch is applied before catching up. */
export class MarkdownSession {
  private raw = '';
  private version = 0;
  private applied = 0;
  private epoch = 0;
  private inFlight = 0;
  private finalized = false;
  private active = true;
  private failed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private port: ParserPort | undefined;
  private engine = new MarkdownEngine();
  private blocks: readonly AstBlock[] = [];

  constructor(private readonly documentId: string, private readonly publish: (blocks: readonly AstBlock[], stats: ParseStats) => void,
    private readonly fail: (message: string) => void, private readonly factory?: (streaming: boolean) => ParserPort) {}

  update(text: string, finalized: boolean) {
    if (!this.active || this.failed) return;
    if (text !== this.raw && (this.finalized || !text.startsWith(this.raw))) {
      this.closePort(); this.epoch++; this.applied = 0; this.version = 0; this.inFlight = 0; this.raw = ''; this.engine = new MarkdownEngine();
    }
    if (text !== this.raw || !this.version) { this.raw = text; this.version++; }
    this.finalized = finalized;
    this.schedule();
  }

  dispose() { this.active = false; this.closePort(); }

  private closePort() {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.port) { this.port.onmessage = null; this.port.onerror = null; this.port.terminate(); this.port = undefined; }
  }

  private reportFailure() { this.failed = true; this.closePort(); this.fail('Не удалось обновить форматирование. Исходный ответ сохранён.'); }

  private schedule() {
    if (!this.active || this.failed || this.inFlight) return;
    if (this.applied === this.version) { if (this.finalized) this.closePort(); return; }
    if (!this.factory) {
      try {
        const result = this.engine.update(this.raw);
        this.blocks = result.blocks; this.applied = this.version; this.publish(result.blocks, result.stats);
      } catch { this.reportFailure(); }
      return;
    }
    if (this.timer && !this.finalized) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        if (!this.port) {
          this.port = this.factory!(!this.finalized);
          this.port.onmessage = (event) => this.receive(event.data);
          this.port.onerror = () => this.reportFailure();
        }
        this.inFlight = this.version;
        this.port.postMessage({ documentId: this.documentId, epoch: this.epoch, baseVersion: this.applied, version: this.version, text: this.raw });
      } catch { this.reportFailure(); }
    }, this.finalized ? 0 : 35);
  }

  private receive(patch: WorkerReply) {
    if (!this.active || patch.documentId !== this.documentId || patch.epoch !== this.epoch || patch.version !== this.inFlight) return;
    this.inFlight = 0;
    if ('error' in patch || patch.baseVersion !== this.applied || patch.version <= this.applied || patch.version > this.version) { this.reportFailure(); return; }
    const lookup = new Map(this.blocks.map((block) => [block.id, block]));
    for (const block of patch.changed) lookup.set(block.id, block);
    const blocks = patch.order.map((id) => lookup.get(id));
    if (blocks.some((block) => !block)) { this.reportFailure(); return; }
    this.blocks = blocks as AstBlock[];
    this.applied = patch.version;
    this.publish(this.blocks, patch.stats);
    this.schedule();
  }
}
