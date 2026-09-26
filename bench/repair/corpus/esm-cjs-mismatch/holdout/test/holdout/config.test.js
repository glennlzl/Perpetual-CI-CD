import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/index.js';

test('holdout: deep overrides keep their siblings and ignore other variables', () => {
  const config = loadConfig({ env: { APP__LOG__JSON: 'true', APP__FEATURES__BETA: 'true', APP__SERVER__HOST: '0.0.0.0', HOME: '/root' } });
  assert.deepEqual(config, { server: { host: '0.0.0.0', port: 8080 }, log: { level: 'info', json: true }, features: { beta: true } });
});

test('holdout: the package loads from another working directory', () => {
  const entry = fileURLToPath(new URL('../../src/index.js', import.meta.url));
  const printed = execFileSync(process.execPath, ['--input-type=module', '-e', `import { loadConfig } from ${JSON.stringify(entry)}; console.log(JSON.stringify(loadConfig({ env: {} })));`], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(JSON.parse(printed).server.port, 8080);
});
