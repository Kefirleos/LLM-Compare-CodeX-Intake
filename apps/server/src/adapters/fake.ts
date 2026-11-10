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
  capabilities: { streaming: 'supported', reasoning: 'unsupported' },
  pricing: null, metadataSource: 'mock',
}));

const defaultScenarios: Record<string, Scenario> = {
  'mock-clear': { delayMs: 300, outcome: 'success' },
  'mock-detailed': { delayMs: 600, outcome: 'success' },
  'mock-slow': { delayMs: 2500, outcome: 'success' },
  'mock-error': { delayMs: 400, outcome: 'error' },
};

export class FakeAdapter implements LlmAdapter {
  readonly mode = 'mock';
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
    const answer = `Тестовый ответ на вопрос: «${input.prompt}».\n\nЭто демонстрационные данные, без обращения к языковой модели.`;
    if (input.modelId !== 'mock-detailed') return { text: answer };
    return { text: [
      '## Демонстрационный ответ', '', answer, '', '### Что можно сравнить', '',
      '- Содержание ответов на один вопрос.', '- Измеренное время каждой попытки.',
      '- Ошибки и повтор отдельной колонки.', '',
      '| Параметр | Значение |', '| --- | --- |', '| Источник | Тестовый адаптер |', '| Контекст | Один вопрос |', '',
      '### Пример кода', '', '```javascript', `const question = ${JSON.stringify(input.prompt)};`, 'console.log(question);', '```', '',
      '> Этот ответ проверяет форматирование и не содержит сведений, полученных от языковой модели.',
    ].join('\n') };
  }

  async *stream(input: PreparedPrompt, signal: AbortSignal): AsyncGenerator<string> {
    // Reuse the same fixture; expose actual partial chunks over time in demo mode.
    const result = await this.generate(input, signal);
    for (const chunk of result.text.match(/\S+\s*|\s+/gu) ?? []) {
      await setTimeout(15, undefined, { signal });
      yield chunk;
    }
  }
}
