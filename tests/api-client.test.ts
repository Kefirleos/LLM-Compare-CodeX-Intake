import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonRequest, ComparisonResponse } from '@llm-compare/contracts';
import { sendComparison } from '../apps/web/src/api/comparisons';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const input: ComparisonRequest = {
    protocolVersion: 1, conversationId: randomUUID(), runId: randomUUID(), turnId: randomUUID(), prompt: 'Вопрос',
    targets: ['a', 'b'].map((modelId) => ({ columnId: randomUUID(), attemptId: randomUUID(), modelId, history: [] })),
  };
  const output: ComparisonResponse = {
    protocolVersion: 1, conversationId: input.conversationId, runId: input.runId, turnId: input.turnId,
    results: input.targets.map((target) => ({
      columnId: target.columnId, attemptId: target.attemptId, modelId: target.modelId,
      status: 'succeeded', text: target.modelId, totalMs: 10, error: null,
    })),
  };
  return { input, output };
}

describe('response identity at the client boundary', () => {
  it('accepts valid results even when they arrive in a different order', async () => {
    const { input, output } = fixture();
    output.results.reverse();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(output)));
    expect(await sendComparison(input, new AbortController().signal)).toEqual(output);
  });

  it.each(['runId', 'turnId', 'conversationId'] as const)('rejects a response from another %s', async (field) => {
    const { input, output } = fixture();
    output[field] = randomUUID();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(output)));
    await expect(sendComparison(input, new AbortController().signal)).rejects.toThrow('не соответствует');
  });

  it('rejects duplicate column results instead of losing a pending answer', async () => {
    const { input, output } = fixture();
    output.results[1] = output.results[0]!;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(output)));
    await expect(sendComparison(input, new AbortController().signal)).rejects.toThrow('не соответствует');
  });

  it('rejects a result from an earlier attempt in the same column', async () => {
    const { input, output } = fixture();
    output.results[0]!.attemptId = randomUUID();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(output)));
    await expect(sendComparison(input, new AbortController().signal)).rejects.toThrow('не соответствует');
  });

  it('does not display a raw HTML server error', async () => {
    const { input } = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private traceback</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })));
    await expect(sendComparison(input, new AbortController().signal)).rejects.toThrow('неожиданный формат');
  });
});
