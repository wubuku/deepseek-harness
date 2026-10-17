import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  base: '/assistant-ui-poc/',
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@deepseek-ai/cordis': resolve(repositoryRoot, 'vendor/cordis'),
      '@deepseek-ai/dsh-client-web/injections': resolve(
        repositoryRoot,
        'packages/client/web/lib/apply-injections.js',
      ),
      '@deepseek-ai/dsh-client-web': resolve(repositoryRoot, 'packages/client/web'),
      '@deepseek-ai/dsh-api-session-controller/client': resolve(
        repositoryRoot,
        'packages/api/session-controller/lib/client.js',
      ),
      '@deepseek-ai/dsh-client-modules/client': resolve(repositoryRoot, 'packages/client/modules/lib/client.js'),
      '@deepseek-ai/dsh-experimental-webworker-runtime/client': resolve(
        repositoryRoot,
        'packages/experimental/webworker-runtime/lib/client.js',
      ),
      'node:module': resolve(repositoryRoot, 'apps/web/src/node-module-stub.ts'),
    },
  },
  server: {
    fs: {
      allow: [repositoryRoot],
    },
  },
  build: {
    outDir: resolve(repositoryRoot, 'apps/web/dist/assistant-ui-poc'),
    emptyOutDir: false,
  },
  define: {
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
