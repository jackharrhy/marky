import { createAssetServer } from 'remix/assets'

// Browser-reachable source files. Server-only modules under app/data/ and
// app/middleware/ are excluded so they cannot leak into client bundles.
export const assets = createAssetServer({
  basePath: '/assets',
  rootDir: process.cwd(),
  fileMap: {
    'app/*path': 'app/*path',
    'node_modules/*path': 'node_modules/*path',
  },
  allow: [
    'app/assets/**',
    'app/frontend/**',
    'app/shared/**',
    'app/ui/**',
    'node_modules/**',
  ],
  deny: ['app/**/*.server.*', 'app/data/**', 'app/middleware/**'],
  sourceMaps: process.env.NODE_ENV === 'development' ? 'external' : undefined,
  scripts: {
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    },
  },
})
