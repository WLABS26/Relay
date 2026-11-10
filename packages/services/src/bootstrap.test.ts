import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@relay/config';
import { ensureStorage, type BucketProvisioner } from './bootstrap';

const config = parseConfig({
  RELAY_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  DATABASE_URL: 'postgres://owner:x@localhost/relay',
  S3_BUCKET: 'relay-unit',
  RELAY_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
});

function provisioner(
  ensure: () => Promise<void>,
  describe: () => Promise<{ versioning: boolean; corsOrigins: string[] }>,
) {
  const storage: BucketProvisioner = {
    ensureBucket: vi.fn(ensure),
    describeBucket: vi.fn(describe),
  };
  const log: string[] = [];
  return { storage, log, run: () => ensureStorage(config, (m) => log.push(m), storage) };
}

const denied = () => Promise.reject(new Error('AccessDenied: s3:PutBucketCORS'));

describe('ensureStorage', () => {
  it('provisions the bucket for the public origin and does not inspect it afterwards', async () => {
    const { storage, log, run } = provisioner(
      () => Promise.resolve(),
      () => Promise.reject(new Error('unexpected')),
    );
    await run();
    expect(storage.ensureBucket).toHaveBeenCalledWith(['http://localhost:3000']);
    expect(storage.describeBucket).not.toHaveBeenCalled();
    expect(log.join('\n')).toContain('CORS allows http://localhost:3000');
  });

  it('accepts a hand-provisioned bucket when versioning is on and CORS allows the origin', async () => {
    for (const origins of [
      ['http://localhost:3000'],
      ['https://other.example', 'http://localhost:3000'],
    ]) {
      const { log, run } = provisioner(denied, () =>
        Promise.resolve({ versioning: true, corsOrigins: origins }),
      );
      await run();
      expect(log.join('\n')).toContain('existing versioning and CORS verified');
    }
  });

  it.each([
    ['versioning off', { versioning: false, corsOrigins: ['http://localhost:3000'] }],
    ['CORS for another origin only', { versioning: true, corsOrigins: ['https://other.example'] }],
    ['no CORS at all', { versioning: true, corsOrigins: [] }],
    ['only a wildcard CORS rule', { versioning: true, corsOrigins: ['*'] }],
  ])('fails closed when settings cannot be applied and the bucket has %s', async (_, state) => {
    const { run } = provisioner(denied, () => Promise.resolve(state));
    await expect(run()).rejects.toThrow(/bucket "relay-unit" is not ready \(AccessDenied/);
  });

  it('fails closed when the bucket cannot be inspected either, keeping the original cause', async () => {
    const { run } = provisioner(denied, () => Promise.reject(new Error('AccessDenied: GetBucket')));
    const error = await run().then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error & { cause?: unknown },
    );
    expect(error.message).toMatch(/s3:PutBucketVersioning and s3:PutBucketCORS/);
    expect((error.cause as Error).message).toContain('s3:PutBucketCORS');
  });
});
