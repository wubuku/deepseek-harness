import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  base: '/saas-agentic-ui-comparison-poc/',
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
      '@assistant-ui/react': resolve(import.meta.dirname, 'node_modules/@assistant-ui/react'),
      '@ag-ui/client': resolve(import.meta.dirname, 'node_modules/@ag-ui/client'),
      '@ag-ui/core/schemas': resolve(import.meta.dirname, 'node_modules/@ag-ui/core/dist/schemas.mjs'),
      '@ag-ui/core': resolve(import.meta.dirname, 'node_modules/@ag-ui/core'),
      'rxjs': resolve(import.meta.dirname, 'node_modules/rxjs'),
      'node:module': resolve(repositoryRoot, 'apps/web/src/node-module-stub.ts'),
    },
  },
  server: {
    fs: {
      allow: [repositoryRoot],
    },
  },
  build: {
    rollupOptions: {
      input: [resolve(import.meta.dirname, 'index.html'), resolve(import.meta.dirname, 'complex/index.html')],
    },
    outDir: resolve(repositoryRoot, 'apps/web/dist/saas-agentic-ui-comparison-poc'),
    emptyOutDir: false,
  },
  define: {
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
