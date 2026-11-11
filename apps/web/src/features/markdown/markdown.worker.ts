import { MarkdownEngine } from './engine';
import type { AstBlock } from './engine';
import type { AstPatch, ParseRequest, WorkerReply } from './session';

const scope = self as unknown as { onmessage: ((event: MessageEvent<ParseRequest>) => void) | null; postMessage(reply: WorkerReply): void };
const engine = new MarkdownEngine();
let version = 0;
let blocks = new Map<string, AstBlock>();
scope.onmessage = ({ data }) => {
  const { text, ...identity } = data;
  try {
    if (identity.baseVersion !== version) throw new Error('Version mismatch');
    const result = engine.update(text);
    const patch: AstPatch = { ...identity, changed: result.blocks.filter((block) => blocks.get(block.id) !== block), order: result.blocks.map((block) => block.id), stats: result.stats };
    blocks = new Map(result.blocks.map((block) => [block.id, block]));
    version = identity.version;
    scope.postMessage(patch);
  } catch { scope.postMessage({ ...identity, error: 'Parse failed' }); }
};
