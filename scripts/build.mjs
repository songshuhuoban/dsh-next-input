import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
});

const client = await build({
  entryPoints: ['src/client.tsx'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  metafile: true,
});
const allowed = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']);
for (const output of Object.values(client.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !allowed.has(dependency.path)) {
      throw new Error(`Unsupported browser external: ${dependency.path}`);
    }
  }
}
// Match the dsh lazy CommonJS loader. Nothing executes until materialization.
await writeFile('dist/client.js', `window.__ModuleLoader__.load({
  id: "dsh-next-input",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
${client.outputFiles[0].text}
    return module.exports;
  }
});\n`);
