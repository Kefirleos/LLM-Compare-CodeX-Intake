import { z } from 'zod';
import { MAX_SAVED_CONVERSATIONS, savedConversationSchema, validateData } from './schema';
import type { ConversationData, SavedConversation } from './schema';

const metaSchema = z.strictObject({ schemaVersion: z.literal(1), generation: z.number().int().nonnegative(), enabled: z.boolean() });
export type StorageMeta = z.infer<typeof metaSchema>;
const headerSchema = z.object({ schemaVersion: z.literal(1), status: z.enum(['saved', 'deleted']), conversationId: z.uuid(), revision: z.number().int().positive(), generation: z.number().int().nonnegative() });
export class StorageError extends Error {
  constructor(readonly code: 'CONFLICT' | 'UNSUPPORTED' | 'CORRUPT' | 'LIMIT' | 'UNAVAILABLE' | 'DISABLED') { super(code); }
}
export interface HistoryEntry { id: string; title: string; updatedAt: number; mode: 'mock' | 'live'; revision: number }
export interface HistoryList { meta: StorageMeta; entries: HistoryEntry[]; invalidIds: string[] }
export type HistoryNotice = { type: 'save' | 'remove' | 'clear' | 'preferences'; generation: number; id?: string | undefined; revision?: number | undefined };
const noticeSchema = z.object({ type: z.enum(['save', 'remove', 'clear', 'preferences']), generation: z.number().int().nonnegative(), id: z.uuid().optional(), revision: z.number().int().positive().optional() });
const request = <T>(input: IDBRequest<T>) => new Promise<T>((resolve, reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error); });

export class ConversationRepository {
  private db: Promise<IDBDatabase> | undefined;
  private channel: BroadcastChannel | undefined;
  private listeners = new Set<(notice: HistoryNotice) => void>();
  constructor(private readonly factory: IDBFactory, private readonly name = 'llm-compare-history', broadcast = false) {
    if (broadcast && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(name);
        this.channel.onmessage = ({ data }: MessageEvent<unknown>) => { const parsed = noticeSchema.safeParse(data); if (parsed.success) this.listeners.forEach((listener) => listener(parsed.data)); };
      } catch { /* Atomic DB checks still protect data without notifications. */ }
    }
  }
  subscribe(listener: (notice: HistoryNotice) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { this.channel?.close(); this.channel = undefined; this.listeners.clear(); void this.db?.then((db) => db.close()).catch(() => {}); }
  private announce(notice: HistoryNotice) { try { this.channel?.postMessage(notice); } catch { /* Notifications never determine transaction success. */ } }

  private open() {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      let opened: IDBOpenDBRequest;
      let rejected = false;
      try { opened = this.factory.open(this.name, 1); } catch { reject(new StorageError('UNAVAILABLE')); return; }
      opened.onupgradeneeded = () => {
        const db = opened.result;
        db.createObjectStore('meta').put({ schemaVersion: 1, generation: 0, enabled: true }, 'state');
        db.createObjectStore('conversations', { keyPath: 'conversationId' }).createIndex('status', 'status');
      };
      opened.onsuccess = () => { if (rejected) { opened.result.close(); return; } opened.result.onversionchange = () => opened.result.close(); resolve(opened.result); };
      opened.onerror = () => reject(new StorageError(opened.error?.name === 'VersionError' ? 'UNSUPPORTED' : 'UNAVAILABLE'));
      opened.onblocked = () => { rejected = true; reject(new StorageError('UNAVAILABLE')); };
    });
    return this.db;
  }

  private async transaction<T>(write: boolean, operation: (tx: IDBTransaction, meta: StorageMeta) => Promise<T>): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(['meta', 'conversations'], write ? 'readwrite' : 'readonly');
    const completed = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new StorageError('UNAVAILABLE')); tx.onerror = () => {}; });
    try {
      const raw: unknown = await request(tx.objectStore('meta').get('state'));
      const parsed = metaSchema.safeParse(raw);
      if (!parsed.success) throw new StorageError('UNSUPPORTED');
      const result = await operation(tx, parsed.data);
      await completed;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Transaction already completed/aborted. */ }
      await completed.catch(() => {});
      throw error;
    }
  }

  async list(): Promise<HistoryList> {
    return this.transaction(false, async (tx, meta) => {
      const rows: unknown[] = await request(tx.objectStore('conversations').getAll());
      const entries: HistoryEntry[] = []; const invalidIds: string[] = [];
      for (const row of rows) {
        const header = headerSchema.safeParse(row);
        if (header.success && header.data.status === 'deleted') continue;
        const parsed = savedConversationSchema.safeParse(row);
        if (!parsed.success || parsed.data.generation !== meta.generation) {
          invalidIds.push(header.success ? header.data.conversationId : 'unknown'); continue;
        }
        const { data, updatedAt, revision } = parsed.data;
        try { validateData(data); } catch { invalidIds.push(data.conversationId); continue; }
        entries.push({ id: data.conversationId, title: data.turns[0]?.prompt.slice(0, 80) || data.draft.slice(0, 80) || 'Новое сравнение', updatedAt, revision, mode: data.mode });
      }
      return { meta, invalidIds, entries: entries.sort((a, b) => b.updatedAt - a.updatedAt) };
    });
  }

  async load(id: string): Promise<{ meta: StorageMeta; record: SavedConversation | null }> {
    return this.transaction(false, async (tx, meta) => {
      const raw: unknown = await request(tx.objectStore('conversations').get(id));
      if (raw === undefined) return { meta, record: null };
      const header = headerSchema.safeParse(raw);
      if (header.success && header.data.status === 'deleted') return { meta, record: null };
      if (typeof raw === 'object' && raw && 'schemaVersion' in raw && raw.schemaVersion !== 1) throw new StorageError('UNSUPPORTED');
      const parsed = savedConversationSchema.safeParse(raw);
      if (!parsed.success) throw new StorageError('CORRUPT');
      validateData(parsed.data.data);
      if (parsed.data.generation !== meta.generation) throw new StorageError('CONFLICT');
      return { meta, record: parsed.data };
    });
  }

  async saveSnapshot(input: ConversationData, expectedRevision: number, generation: number): Promise<SavedConversation> {
    const data = validateData(input);
    const result = await this.transaction(true, async (tx, meta) => {
      if (meta.generation !== generation) throw new StorageError('CONFLICT');
      if (!meta.enabled) throw new StorageError('DISABLED');
      const store = tx.objectStore('conversations');
      const raw: unknown = await request(store.get(data.conversationId));
      if (raw !== undefined) {
        const header = headerSchema.safeParse(raw);
        if (!header.success) throw new StorageError('UNSUPPORTED');
        if (header.data.status === 'deleted' || header.data.revision !== expectedRevision || header.data.generation !== generation) throw new StorageError('CONFLICT');
        if (!savedConversationSchema.safeParse(raw).success) throw new StorageError('CORRUPT');
      } else {
        if (expectedRevision !== 0) throw new StorageError('CONFLICT');
        if (await request(store.index('status').count('saved')) >= MAX_SAVED_CONVERSATIONS || await request(store.count()) >= 500) throw new StorageError('LIMIT');
      }
      const record: SavedConversation = { schemaVersion: 1, status: 'saved', conversationId: data.conversationId, data, revision: expectedRevision + 1, generation, updatedAt: Date.now() };
      await request(store.put(record));
      return record;
    });
    this.announce({ type: 'save', generation, id: data.conversationId, revision: result.revision });
    return result;
  }

  async remove(id: string, expectedRevision: number, generation: number) {
    await this.transaction(true, async (tx, meta) => {
      if (meta.generation !== generation) throw new StorageError('CONFLICT');
      const store = tx.objectStore('conversations');
      const raw: unknown = await request(store.get(id));
      const header = headerSchema.safeParse(raw);
      if (!header.success || header.data.status === 'deleted' || header.data.revision !== expectedRevision) throw new StorageError('CONFLICT');
      await request(store.put({ schemaVersion: 1, status: 'deleted', conversationId: id, revision: expectedRevision + 1, generation }));
    });
    this.announce({ type: 'remove', generation, id });
  }

  async clear(generation: number) {
    const meta = await this.transaction(true, async (tx, current) => {
      if (current.generation !== generation) throw new StorageError('CONFLICT');
      const next = { ...current, generation: generation + 1 };
      await request(tx.objectStore('conversations').clear()); await request(tx.objectStore('meta').put(next, 'state'));
      return next;
    });
    this.announce({ type: 'clear', generation: meta.generation });
    return meta;
  }

  async setEnabled(enabled: boolean, generation: number) {
    await this.transaction(true, async (tx, meta) => {
      if (meta.generation !== generation) throw new StorageError('CONFLICT');
      await request(tx.objectStore('meta').put({ ...meta, enabled }, 'state'));
    });
    this.announce({ type: 'preferences', generation });
  }
}
