import type { PublicError } from '@llm-compare/contracts';

export class AdapterError extends Error {
  constructor(readonly publicError: PublicError) {
    super(publicError.message);
    this.name = 'AdapterError';
  }
}
