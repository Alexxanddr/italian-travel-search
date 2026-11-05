import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'API_');
  const target = env.API_ORIGIN || 'http://127.0.0.1:3000';
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('API_ORIGIN must be an HTTP(S) origin without credentials or path');
  const proxy = { '/api': { target: url.origin, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/api(?=\/)/, '') } };
  return { server: { proxy }, preview: { proxy } };
});
