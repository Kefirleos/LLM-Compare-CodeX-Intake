import type { ModelDescriptor } from '@llm-compare/contracts';

export interface PreparedPrompt {
  modelId: string;
  prompt: string;
}

export interface GenerationResult {
  text: string;
}

export interface LlmAdapter {
  listModels(signal: AbortSignal): Promise<ModelDescriptor[]>;
  generate(input: PreparedPrompt, signal: AbortSignal): Promise<GenerationResult>;
}
