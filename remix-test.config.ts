import type { RemixTestConfig } from 'remix/test'

const config: RemixTestConfig = {
  glob: {
    test: 'test/**/*.test.ts',
    exclude: 'node_modules/**',
  },
  coverage: {
    dir: '.coverage',
    include: ['app/**/*.{ts,tsx}'],
    // Browser-only modules (app/frontend, app/ui) are hydrated in the browser
    // and aren't unit-tested at the server-test layer. They want component
    // tests via `render()` from remix/ui/test, which we don't have yet.
    exclude: [
      'app/**/*.test.{ts,tsx}',
      'app/frontend/**',
      'app/ui/**',
      'app/assets/**',
    ],
    statements: 80,
    lines: 80,
    branches: 70,
    functions: 80,
  },
}

export default config
