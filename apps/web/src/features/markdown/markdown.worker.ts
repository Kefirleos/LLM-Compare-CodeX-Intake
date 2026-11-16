import { MarkdownEngine } from './engine';
import type { AstBlock } from './engine';
import type { AstPatch, ParseRequest, WorkerReply } from './session';

const scope = self as unknown as { onmessage: ((event: MessageEvent<ParseRequest>) => void) | null; postMessage(reply: WorkerReply): void };
let engine = new MarkdownEngine();
let documentId: string | undefined;
let epoch: number | undefined;
let version = 0;
let blocks = new Map<string, AstBlock>();
scope.onmessage = ({ data }) => {
  const { text, ...identity } = data;
  try {
    if (identity.baseVersion === 0) {
      engine = new MarkdownEngine();
      documentId = identity.documentId;
      epoch = identity.epoch;
      version = 0;
      blocks.clear();
    }
    if (identity.documentId !== documentId || identity.epoch !== epoch || identity.baseVersion !== version || identity.version <= version) {
      throw new Error('Version mismatch');
    }
    const result = engine.update(text);
    const patch: AstPatch = { ...identity, changed: result.blocks.filter((block) => blocks.get(block.id) !== block), order: result.blocks.map((block) => block.id), stats: result.stats };
    blocks = new Map(result.blocks.map((block) => [block.id, block]));
    version = identity.version;
    scope.postMessage(patch);
  } catch { scope.postMessage({ ...identity, error: 'Parse failed' }); }
};
