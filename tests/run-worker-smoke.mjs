import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const state = mkdtempSync(resolve(tmpdir(), 'atolle-worker-test-'));
const wrangler = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
let worker;

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv, CI: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.listen(0, '127.0.0.1', resolvePromise).once('error', reject));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 8787;
  await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitForWorker(origin, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited before becoming ready.\n${output.value}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for Wrangler.\n${output.value}`);
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  worker.kill('SIGTERM');
  const exited = new Promise(resolvePromise => worker.once('exit', resolvePromise));
  const timeout = new Promise(resolvePromise => setTimeout(resolvePromise, 3_000, 'timeout'));
  if (await Promise.race([exited, timeout]) === 'timeout') worker.kill('SIGKILL');
}

try {
  run(process.execPath, ['scripts/build.mjs']);
  run(wrangler, ['d1', 'migrations', 'apply', 'DB', '--env', 'staging', '--local', '--persist-to', state]);
  run(wrangler, ['d1', 'execute', 'DB', '--env', 'staging', '--local', '--persist-to', state, '--file', 'tests/worker-fixture.sql', '--yes']);

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const output = { value: '' };
  worker = spawn(wrangler, ['dev', '--env', 'staging', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--log-level', 'warn'], {
    cwd: root,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = chunk => { output.value = `${output.value}${chunk}`.slice(-16_000); };
  worker.stdout.on('data', capture);
  worker.stderr.on('data', capture);
  await waitForWorker(origin, output);
  run(process.execPath, ['tests/worker-smoke.mjs'], { ATOLLE_TEST_ORIGIN: origin });
} finally {
  await stopWorker();
  rmSync(state, { recursive: true, force: true });
}
