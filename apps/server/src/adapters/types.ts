import type { ModelDescriptor, HistoryPair } from '@llm-compare/contracts';

export interface PreparedPrompt {
  modelId: string;
  prompt: string;
  history?: readonly HistoryPair[];
}

export interface GenerationResult {
  text: string;
  usage?: ReportedUsage;
}
export interface ReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}
export type StreamChunk = string | { type: 'reasoning_started' | 'reasoning_ended' } | { type: 'reasoning_delta'; text: string }
  | { type: 'usage'; usage: ReportedUsage };

export interface LlmAdapter {
  readonly mode: 'mock' | 'live';
  listModels(signal: AbortSignal): Promise<ModelDescriptor[]>;
  generate(input: PreparedPrompt, signal: AbortSignal): Promise<GenerationResult>;
  stream?(input: PreparedPrompt, signal: AbortSignal, onActivity?: () => void): AsyncIterable<StreamChunk>;
}
