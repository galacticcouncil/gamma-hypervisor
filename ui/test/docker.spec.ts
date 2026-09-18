import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// image smoke, ci only: DOCKER_SMOKE=1 npx vitest run test/docker.spec.ts
// builds ui/Dockerfile from the REPO ROOT (the only context it supports), starts
// it on an empty anonymous volume with nothing but RPC_URL set and waits for
// /healthz 200. the failure it pins: a root:root /data makes DatabaseSync EACCES
// and the swarm task restart-loop.
const smoke = process.env.DOCKER_SMOKE === '1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tag = `gamma-ui:smoke-${process.pid}`;
const rpcUrl = process.env.SMOKE_RPC_URL ?? 'https://rpc.hydradx.cloud';
let container: string | null = null;

function docker(args: string[], timeoutMs = 120_000): string {
  return execFileSync('docker', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

async function waitFor200(url: string, deadline: number): Promise<string> {
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      last = String(r.status);
      if (r.status === 200) return last;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

afterAll(() => {
  // -v drops the anonymous /data and /backup volumes with the container
  if (container) spawnSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore' });
  if (smoke) spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' });
});

describe.skipIf(!smoke)('docker image', () => {
  it('builds from the repo root and answers /healthz 200 on an empty volume', async () => {
    docker(['build', '-f', 'ui/Dockerfile', '--build-arg', 'COMMIT=smoke', '-t', tag, '.'], 900_000);
    container = docker(['run', '-d', '-p', '127.0.0.1::3000', '-e', `RPC_URL=${rpcUrl}`, tag]);

    const port = docker(['port', container, '3000/tcp']).split('\n')[0].split(':').pop();
    const status = await waitFor200(`http://127.0.0.1:${port}/healthz`, Date.now() + 120_000);
    if (status !== '200') {
      const logs = spawnSync('docker', ['logs', '--tail', '40', container], { encoding: 'utf8' });
      expect(status, `${logs.stdout}\n${logs.stderr}`).toBe('200');
    }

    // unprivileged, and the volumes belong to the process that writes them
    const who = docker(['exec', container, 'sh', '-c', 'id -un; stat -c %U /data /backup']).split('\n');
    expect(who).toEqual(['ui', 'ui', 'ui']);
  }, 1_200_000);
});
