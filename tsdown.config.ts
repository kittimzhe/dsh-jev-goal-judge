import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  platform: 'node',
  target: 'node20',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
