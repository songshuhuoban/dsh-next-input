import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const source = await readFile('dist/client.js', 'utf8');
let record;
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(value) { record = value; } } },
});
assert.equal(record.id, manifest.name);
assert.equal(typeof record.factory, 'function');
const requestedModules = [];
const plugin = record.factory((specifier) => {
  requestedModules.push(specifier);
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier);
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {};
  throw new Error(`Browser factory imported unsupported module ${specifier}`);
});
assert.equal(typeof plugin.apply, 'function');
assert.ok(Array.isArray(plugin.inject));
assert.ok(!requestedModules.some((specifier) => specifier.startsWith('node:')));

const host = await import('../dist/index.js');
assert.equal(typeof host.apply, 'function');
assert.ok(host.Config);
assert.ok(Array.isArray(host.inject));

// Fixed command with no interpolated input, so Windows npm.cmd works too.
const packOutput = execSync('npm pack --dry-run --ignore-scripts --json', {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const paths = new Set(JSON.parse(packOutput)[0].files.map((file) => file.path));
for (const path of ['dist/index.js', 'dist/client.js', 'dist/types/index.d.ts', 'dist/types/client.d.ts', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'README.md', 'LICENSE']) {
  assert.ok(paths.has(path), `Missing publish artifact: ${path}`);
}
assert.ok(![...paths].some((path) => path.startsWith('tests/') || path.startsWith('node_modules/')));
console.log('Package exports and lazy browser factory verified.');
