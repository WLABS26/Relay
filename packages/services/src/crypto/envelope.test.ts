import { describe, expect, it } from 'vitest';
import { isConfigError, parseConfig } from '@relay/config';
import { DecryptionError, EnvelopeEncryptor, LocalKeyringProvider, createEncryptor, secretAad } from './envelope';

const key = (fill: number) => Buffer.alloc(32, fill);
const aad = secretAad({ purpose: 'oauth_token', workspaceId: 'w1', provider: 'youtube', grantId: 'g1', id: 'row1' });

describe('envelope encryption', () => {
  it('round-trips and never repeats a ciphertext', async () => {
    const enc = new EnvelopeEncryptor(new LocalKeyringProvider([{ kid: 'k1', key: key(1) }]));
    const a = await enc.encrypt('refresh-token-value', aad);
    const b = await enc.encrypt('refresh-token-value', aad);
    expect(a.equals(b)).toBe(false); // fresh DEK and IV each time
    expect((await enc.decrypt(a, aad)).toString('utf8')).toBe('refresh-token-value');
    expect(a.includes(Buffer.from('refresh-token-value'))).toBe(false);
  });

  it.each([
    ['another tenant', { workspaceId: 'w2' }],
    ['another provider', { provider: 'tiktok' }],
    ['another grant', { grantId: 'g2' }],
    ['another row', { id: 'row2' }],
    ['another purpose', { purpose: 'oidc_login' }],
  ])('refuses to decrypt a ciphertext moved to %s', async (_, change) => {
    const enc = new EnvelopeEncryptor(new LocalKeyringProvider([{ kid: 'k1', key: key(1) }]));
    const sealed = await enc.encrypt('secret', aad);
    const moved = secretAad({ purpose: 'oauth_token', workspaceId: 'w1', provider: 'youtube', grantId: 'g1', id: 'row1', ...change });
    await expect(enc.decrypt(sealed, moved)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('detects any tampered byte', async () => {
    const enc = new EnvelopeEncryptor(new LocalKeyringProvider([{ kid: 'k1', key: key(1) }]));
    const sealed = await enc.encrypt('secret', aad);
    for (const index of [5, 20, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[index] = copy[index]! ^ 0x01;
      await expect(enc.decrypt(copy, aad)).rejects.toBeInstanceOf(DecryptionError);
    }
    await expect(enc.decrypt(sealed.subarray(0, 10), aad)).rejects.toBeInstanceOf(DecryptionError);
    await expect(enc.decrypt(Buffer.from([2, 0]), aad)).rejects.toThrow('unsupported ciphertext version');
  });

  it('rotates keys: new data uses the first key, old data still opens with retired keys', async () => {
    const old = new EnvelopeEncryptor(new LocalKeyringProvider([{ kid: 'k1', key: key(1) }]));
    const sealedWithOld = await old.encrypt('legacy', aad);
    const rotated = new EnvelopeEncryptor(new LocalKeyringProvider([{ kid: 'k2', key: key(2) }, { kid: 'k1', key: key(1) }]));
    expect((await rotated.decrypt(sealedWithOld, aad)).toString()).toBe('legacy');
    const fresh = await rotated.encrypt('new', aad);
    expect(fresh.subarray(2, 2 + fresh[1]!).toString()).toBe('k2');
    const withoutOld = new EnvelopeEncryptor(new LocalKeyringProvider([{ kid: 'k2', key: key(2) }]));
    await expect(withoutOld.decrypt(sealedWithOld, aad)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses to start with KMS until its provider exists, as a configuration error', () => {
    const config = parseConfig({
      RELAY_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
      DATABASE_URL_APP: 'postgres://a@localhost/r',
      DATABASE_URL_WORKER: 'postgres://w@localhost/r',
      S3_BUCKET: 'relay-unit',
      RELAY_ENCRYPTION_PROVIDER: 'kms',
      RELAY_KMS_KEY_ID: 'kms-key',
    });
    let caught: unknown;
    try {
      createEncryptor(config);
    } catch (error) {
      caught = error;
    }
    expect(isConfigError(caught)).toBe(true);
    expect((caught as Error).message).toContain('KMS key provider ships with the provider-credential milestone (M3)');
  });
});
