import type { AttemptMetrics, ComparisonTarget, ModelDescriptor } from '@llm-compare/contracts';
import type { ReportedUsage } from '../adapters/types.js';

export type GenerationTarget = ComparisonTarget & { pricing?: ModelDescriptor['pricing'] };

function amount(tokens: number, price: number) {
  const [coefficient = '0', exponent = '0'] = price.toString().split('e');
  return {
    units: BigInt(coefficient.replace('.', '')) * BigInt(tokens),
    exponent: Number(exponent) - (coefficient.split('.')[1]?.length ?? 0),
  };
}

export function usageMetrics(usage?: ReportedUsage, pricing?: ModelDescriptor['pricing']): Pick<AttemptMetrics, 'inputTokens' | 'outputTokens' | 'cost' | 'costBasis'> {
  const inputTokens = usage?.inputTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  if (!pricing || inputTokens === null || outputTokens === null) return { inputTokens, outputTokens, cost: null };

  // Add at a common decimal scale before converting the USD estimate to a JSON number.
  const input = amount(inputTokens, pricing.inputPerMillion);
  const output = amount(outputTokens, pricing.outputPerMillion);
  const exponent = Math.min(input.exponent, output.exponent);
  const sum = input.units * 10n ** BigInt(input.exponent - exponent) + output.units * 10n ** BigInt(output.exponent - exponent);
  const cost = Number(`${sum}e${exponent - 6}`);
  if (!Number.isFinite(cost) || (cost === 0 && sum !== 0n)) return { inputTokens, outputTokens, cost: null };
  return { inputTokens, outputTokens, cost, costBasis: {
    source: 'catalog', method: 'standard_input_output', calculatedAt: Date.now(), pricing: { ...pricing },
  } };
}
