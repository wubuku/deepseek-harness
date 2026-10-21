import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['docs/drafts/browser-native-dsh-poc/tests/**/*.spec.ts'],
    testTimeout: 10_000,
  },
})
