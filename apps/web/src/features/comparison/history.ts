import type { AttemptResult, ComparisonTarget, HistoryPair } from '@llm-compare/contracts';

export type DisplayResult = AttemptResult | { status: 'pending'; attemptId?: string; text?: string; reasoning?: string; reasoningActive?: boolean }
  | { status: 'network_error' | 'stopped'; attemptId?: string; message: string; text?: string; reasoning?: string };
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
  return turns.filter((turn) => turn.results[columnId] && turn.results[columnId]!.status !== 'succeeded').length;
}
