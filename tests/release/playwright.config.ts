import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'chrome' : undefined);
const baseURL = 'http://127.0.0.1:4181';
const host = process.env.LLM_COMPARE_DEMO_IPV6 === '1' ? '::1' : '127.0.0.1';
const env = { HOST: host, PORT: '4311', LLM_MODE: 'mock' };
const apiAuthority = host === '::1' ? '[::1]' : host;
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', timeout: 45_000, workers: 1, reporter: 'list',
  outputDir: '../../test-results/demo',
  use: { baseURL, ...(channel ? { channel } : {}), viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm start', cwd: '../..', url: `http://${apiAuthority}:4311/api/health`, env, reuseExistingServer: false },
    { command: 'npm run preview -w @llm-compare/web -- --port 4181 --strictPort', cwd: '../..', url: baseURL + '/api/health', env, reuseExistingServer: false },
  ],
});
