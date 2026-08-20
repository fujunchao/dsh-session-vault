import { defineConfig } from 'tsdown'

const neverBundle = [/^@deepseek-ai\//, 'react', 'react-dom', 'react/jsx-runtime', 'zod']

export default defineConfig([
  {
    name: 'host',
    entry: { index: 'src/index.ts' },
    format: 'esm',
    platform: 'node',
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    hash: false,
    clean: true,
    dts: false,
    sourcemap: true,
    deps: { neverBundle },
  },
  {
    name: 'client',
    entry: { client: 'src/client.tsx' },
    format: 'cjs',
    platform: 'browser',
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    hash: false,
    clean: false,
    dts: false,
    sourcemap: true,
    deps: { neverBundle },
    outputOptions: { exports: 'named' },
    banner: `window.__ModuleLoader__.load({
  id: "dsh-session-vault",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;`,
    footer: `
    return module.exports;
  }
});`,
  },
])
