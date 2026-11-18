import { defineConfig } from '@playwright/test';
import demo from '../release/playwright.config';

const apiURL = 'http://127.0.0.1:4312';
const baseURL = 'http://127.0.0.1:4182';
const env = { HOST: '127.0.0.1', PORT: '4312', LLM_MODE: 'live' };

export default defineConfig({
  ...demo,
  timeout: 155_000,
  retries: 0,
  outputDir: '../../test-results/live',
  use: { ...demo.use, baseURL, trace: 'off' },
  webServer: [
    { command: 'npm start', cwd: '../..', url: `${apiURL}/api/health`, env, reuseExistingServer: false },
    { command: 'npm run preview -w @llm-compare/web -- --port 4182 --strictPort', cwd: '../..', url: `${baseURL}/api/health`, env, reuseExistingServer: false },
  ],
});
