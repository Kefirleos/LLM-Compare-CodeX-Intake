import type { ModelDescriptor } from '@llm-compare/contracts';

export interface PreparedPrompt {
  modelId: string;
  prompt: string;
}

export interface GenerationResult {
  text: string;
}

export interface LlmAdapter {
  readonly mode: 'mock' | 'live';
  listModels(signal: AbortSignal): Promise<ModelDescriptor[]>;
  generate(input: PreparedPrompt, signal: AbortSignal): Promise<GenerationResult>;
  stream?(input: PreparedPrompt, signal: AbortSignal, onActivity?: () => void): AsyncIterable<string>;
}
