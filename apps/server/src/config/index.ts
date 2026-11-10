import { z } from 'zod';

const configSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LLM_MODE: z.literal('mock').default('mock'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid server configuration: ${fields.join(', ')}`);
  }
  return { host: result.data.HOST, port: result.data.PORT, mode: result.data.LLM_MODE };
}
