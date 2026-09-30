import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the actual dsh 0.2.0-rc.2 compatibility gate reproduces the original package rejection', () => {
  assert.equal(getDshRuntimeVersion(), '0.2.0-rc.2');
  const legacyPeers = {
    '@deepseek-ai/cordis': '~4.0.4',
    '@deepseek-ai/dsh-agent': '0.1.7-rc.2',
    '@deepseek-ai/dsh-llm': '0.1.7-rc.2',
    '@deepseek-ai/dsh-client-connection': '0.1.7-rc.2',
  };
  const rejected = evaluatePluginCompatibility({ ...manifest, version: '0.1.0', peerDependencies: legacyPeers });
  assert.ok(rejected);
  assert.equal(rejected.name, 'dsh-next-input');
  assert.equal(rejected.version, '0.1.0');
  assert.equal(rejected.runtimeVersion, '0.2.0-rc.2');
  assert.equal(rejected.exempted, false);
  const { '@deepseek-ai/cordis': _cordis, ...incompatible } = legacyPeers;
  assert.deepEqual(rejected.peers, incompatible);
});

test('the published-package gate accepts the current manifest without a version exemption', () => {
  assert.equal(evaluatePluginCompatibility(manifest), undefined);
});

test('the manifest keeps unverified Harness versions outside its compatibility range', () => {
  for (const runtimeVersion of ['0.1.7-rc.2', '0.2.0-rc.3']) {
    const rejected = evaluatePluginCompatibility(manifest, {}, runtimeVersion);
    assert.ok(rejected);
    assert.equal(rejected.runtimeVersion, runtimeVersion);
    assert.equal(rejected.exempted, false);
    assert.ok(Object.keys(rejected.peers).length > 0);
  }
});
