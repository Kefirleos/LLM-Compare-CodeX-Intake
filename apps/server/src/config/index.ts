import { z } from 'zod';

const configSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LLM_MODE: z.enum(['mock', 'live']).default('mock'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid server configuration: ${fields.join(', ')}`);
  }
  const common = { host: result.data.HOST, port: result.data.PORT };
  if (result.data.LLM_MODE === 'mock') return { ...common, mode: 'mock' as const };
  const key = z.string().trim().min(1).refine((value) => value !== 'replace_me' && !/[\r\n]/.test(value)).safeParse(env.LLM_API_KEY);
  if (!key.success) throw new Error('Invalid server configuration: LLM_API_KEY');
  // Live mode is local until hosting authentication and spend controls are configured.
  if (!['127.0.0.1', '::1', 'localhost'].includes(common.host)) throw new Error('Invalid live server configuration: HOST must be loopback');
  return { ...common, mode: 'live' as const, apiKey: key.data };
}
