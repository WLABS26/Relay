#!/usr/bin/env node
/**
 * `pnpm infra:up`: start the local PostgreSQL and S3-compatible storage, then make sure the
 * one-shot bucket provisioning finished successfully.
 *
 * `docker compose up --wait` returns once the long-running services are healthy, but the
 * provisioning container may still be running or may already have exited by then.
 * `docker compose wait` only handles the first case (it fails with "no containers" once the
 * container has exited), so the exit code is read with `docker wait`, which works in both.
 */
import { execFileSync, spawnSync } from 'node:child_process';

const compose = ['compose', '-f', 'infra/compose.yaml'];
const PROVISIONER = 's3-provision';

const up = spawnSync('docker', [...compose, 'up', '-d', '--wait'], { stdio: 'inherit' });
if (up.status !== 0) process.exit(up.status ?? 1);

const containerId = execFileSync('docker', [...compose, 'ps', '-aq', PROVISIONER], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')[0];
if (!containerId) {
  console.error(`[infra] the ${PROVISIONER} container was not created`);
  process.exit(1);
}
const exitCode = execFileSync('docker', ['wait', containerId], { encoding: 'utf8' }).trim();
if (exitCode !== '0') {
  console.error(`[infra] bucket provisioning failed (exit code ${exitCode}); its output:`);
  spawnSync('docker', [...compose, 'logs', '--no-color', PROVISIONER], { stdio: 'inherit' });
  process.exit(1);
}
console.log('[infra] PostgreSQL and object storage are up; bucket provisioned.');
