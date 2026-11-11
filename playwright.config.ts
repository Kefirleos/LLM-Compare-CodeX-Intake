import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'chrome' : undefined);
export default defineConfig({
  testDir: './tests/browser', testMatch: '**/*.spec.ts', workers: 1, timeout: 30_000,
  expect: { timeout: 7000 }, outputDir: 'test-results/browser', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4179', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...(channel ? { channel } : {}) },
  webServer: [
    { command: 'node --import tsx tests/browser/server.ts', url: 'http://127.0.0.1:4309/api/health', reuseExistingServer: false },
    { command: 'npm run preview -w @llm-compare/web -- --host 127.0.0.1 --port 4179 --strictPort', url: 'http://127.0.0.1:4179', reuseExistingServer: false, env: { HOST: '127.0.0.1', PORT: '4309', LLM_MODE: 'mock' } },
  ],
});
