import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({
  ...base,
  testMatch: '*.production.spec.ts',
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  webServer: process.env.CONTAINER_TEST === '1' ? undefined : { command: 'node test/production-server.mjs', url: 'http://127.0.0.1:4174/health', reuseExistingServer: false },
});
