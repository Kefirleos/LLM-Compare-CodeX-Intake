import { ConversationRepository } from './repository';
import type { ConversationData, SavedConversation } from './schema';

/** Coalesces checkpoints and serializes writes; older work cannot overwrite a newer revision. */
export class ConversationSaver {
  revision: number;
  private latest: ConversationData | undefined;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private blocked = false;
  private enabled = true;
  private busy = false;
  get hasPending() { return this.latest !== undefined; }
  constructor(private readonly repository: Pick<ConversationRepository, 'saveSnapshot'>, readonly generation: number, revision: number,
    private readonly saved: (record: SavedConversation) => void, private readonly failed: (error: unknown) => void) { this.revision = revision; }
  update(data: ConversationData, busy: boolean) {
    if (this.disposed || this.blocked) return;
    const wasBusy = this.busy;
    this.latest = data; this.busy = busy;
    if (!this.enabled) return;
    if (!busy && wasBusy) { void this.flush(); return; }
    if (!this.running && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 500);
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) { clearTimeout(this.timer); this.timer = undefined; }
    else if (this.latest) this.update(this.latest, this.busy);
  }
  pause() { this.blocked = true; clearTimeout(this.timer); this.timer = undefined; }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.timer = undefined; this.latest = undefined; }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.running) { await this.running; if (!this.busy) await this.flush(); return; }
    if (this.disposed || this.blocked || !this.enabled || !this.latest) return;
    const snapshot = this.latest; this.latest = undefined;
    this.running = (async () => {
      try {
        const record = await this.repository.saveSnapshot(snapshot, this.revision, this.generation);
        this.revision = record.revision;
        if (!this.disposed) this.saved(record);
      } catch (error) { if (!this.disposed) { this.pause(); this.failed(error); } }
    })();
    await this.running; this.running = undefined;
    if (this.latest && !this.disposed && !this.blocked && this.enabled) this.update(this.latest, this.busy);
  }
}
