import type { ComparisonTarget, HistoryPair } from '@llm-compare/contracts';
import type { StoredDisplayResult } from '../storage/schema';

export type DisplayResult = StoredDisplayResult;
export type Turn = {
  turnId: string; prompt: string; results: Record<string, DisplayResult>;
  targets: ComparisonTarget[]; serializerVersion: 1;
  attempts: Record<string, DisplayResult[]>;
};

export function buildHistory(turns: readonly Turn[], columnId: string): HistoryPair[] {
  return turns.flatMap((turn) => {
    const result = turn.results[columnId];
    return result?.status === 'succeeded' ? [{ user: turn.prompt, assistant: result.text }] : [];
  });
}

export function skippedTurns(turns: readonly Turn[], columnId: string): number {
  return turns.filter((turn) => {
    const status = turn.results[columnId]?.status;
    return status && status !== 'pending' && status !== 'succeeded';
  }).length;
}
