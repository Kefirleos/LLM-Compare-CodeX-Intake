import { setTimeout } from 'node:timers/promises';
import type { ModelDescriptor } from '@llm-compare/contracts';
import type { GenerationResult, LlmAdapter, PreparedPrompt } from './types.js';

type Scenario = { delayMs: number; outcome: 'success' | 'error' };

const modelLabels = [
  ['mock-clear', 'Демо · Краткий ответ'],
  ['mock-detailed', 'Демо · Подробный ответ'],
  ['mock-slow', 'Демо · Медленный ответ'],
  ['mock-error', 'Демо · Ошибка'],
] as const;

const models: ModelDescriptor[] = modelLabels.map(([id, displayName]) => ({
  id, displayName, provider: 'Тестовый адаптер',
  capabilities: { streaming: 'unsupported', reasoning: 'unsupported' },
  pricing: null, metadataSource: 'mock',
}));

const defaultScenarios: Record<string, Scenario> = {
  'mock-clear': { delayMs: 300, outcome: 'success' },
  'mock-detailed': { delayMs: 600, outcome: 'success' },
  'mock-slow': { delayMs: 2500, outcome: 'success' },
  'mock-error': { delayMs: 400, outcome: 'error' },
};

export class FakeAdapter implements LlmAdapter {
  constructor(private readonly scenarios: Readonly<Record<string, Scenario>> = defaultScenarios) {}

  async listModels(signal: AbortSignal): Promise<ModelDescriptor[]> {
    signal.throwIfAborted();
    return structuredClone(models);
  }

  async generate(input: PreparedPrompt, signal: AbortSignal): Promise<GenerationResult> {
    signal.throwIfAborted();
    const scenario = this.scenarios[input.modelId];
    if (!scenario) throw new Error('Unknown mock model');
    await setTimeout(scenario.delayMs, undefined, { signal });
    if (scenario.outcome === 'error') throw new Error('Simulated provider failure');
    return { text: `Тестовый ответ на вопрос: «${input.prompt}».\n\nЭто демонстрационные данные, без обращения к языковой модели.` };
  }
}
