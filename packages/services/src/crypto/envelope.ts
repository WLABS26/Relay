import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigError, type RelayConfig } from '@relay/config';

/**
 * Authenticated envelope encryption for credentials and resumable secrets.
 *
 * Each value gets a fresh 256-bit data key (DEK). The plaintext is sealed with AES-256-GCM
 * under the DEK, and the DEK is wrapped by a key-encryption key (KEK): a local keyring entry in
 * development, KMS in production. Both layers authenticate the same associated data, which
 * binds the ciphertext to its tenant, provider, grant and purpose — moving a ciphertext to
 * another row or tenant makes decryption fail.
 *
 * Wire format (v1):
 *   0x01 | kidLen(1) | kid | wrappedLen(2) | wrappedDek | iv(12) | tag(16) | ciphertext
 */

export interface KeyEncryptionProvider {
  readonly activeKeyId: string;
  wrap(dek: Buffer, aad: Buffer): Promise<{ kid: string; wrapped: Buffer }>;
  unwrap(kid: string, wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

export class DecryptionError extends Error {
  constructor(message = 'ciphertext could not be decrypted') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Canonical associated data for a stored secret. */
export function secretAad(parts: { purpose: string; workspaceId?: string | null; provider?: string | null; grantId?: string | null; id?: string | null }): Buffer {
  return Buffer.from(
    ['relay:v1', parts.purpose, parts.workspaceId ?? '-', parts.provider ?? '-', parts.grantId ?? '-', parts.id ?? '-'].join('|'),
    'utf8',
  );
}

function gcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function gcmOpen(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

export class LocalKeyringProvider implements KeyEncryptionProvider {
  readonly activeKeyId: string;
  private readonly keys: Map<string, Buffer>;

  constructor(keyring: Array<{ kid: string; key: Buffer }>) {
    if (keyring.length === 0) throw new Error('LocalKeyringProvider requires at least one key');
    this.keys = new Map(keyring.map((k) => [k.kid, k.key]));
    this.activeKeyId = keyring[0]!.kid;
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<{ kid: string; wrapped: Buffer }> {
    const kek = this.keys.get(this.activeKeyId)!;
    const { iv, tag, ciphertext } = gcmSeal(kek, dek, aad);
    return { kid: this.activeKeyId, wrapped: Buffer.concat([iv, tag, ciphertext]) };
  }

  async unwrap(kid: string, wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    const kek = this.keys.get(kid);
    if (!kek || wrapped.length < 28) throw new DecryptionError(`unknown key id ${kid}`);
    return gcmOpen(kek, wrapped.subarray(0, 12), wrapped.subarray(12, 28), wrapped.subarray(28), aad);
  }
}

export class EnvelopeEncryptor {
  constructor(private readonly kek: KeyEncryptionProvider) {}

  async encrypt(plaintext: Buffer | string, aad: Buffer): Promise<Buffer> {
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const dek = randomBytes(32);
    try {
      const { kid, wrapped } = await this.kek.wrap(dek, aad);
      const { iv, tag, ciphertext } = gcmSeal(dek, data, aad);
      const kidBytes = Buffer.from(kid, 'utf8');
      if (kidBytes.length > 255 || wrapped.length > 65535) throw new Error('key id or wrapped key too long');
      const lens = Buffer.alloc(2);
      lens.writeUInt16BE(wrapped.length);
      return Buffer.concat([Buffer.from([1, kidBytes.length]), kidBytes, lens, wrapped, iv, tag, ciphertext]);
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(sealed: Buffer, aad: Buffer): Promise<Buffer> {
    if (sealed.length < 2 || sealed[0] !== 1) throw new DecryptionError('unsupported ciphertext version');
    const kidLen = sealed[1]!;
    let offset = 2;
    const kid = sealed.subarray(offset, offset + kidLen).toString('utf8');
    offset += kidLen;
    if (sealed.length < offset + 2) throw new DecryptionError();
    const wrappedLen = sealed.readUInt16BE(offset);
    offset += 2;
    const wrapped = sealed.subarray(offset, offset + wrappedLen);
    offset += wrappedLen;
    if (sealed.length < offset + 28) throw new DecryptionError();
    const iv = sealed.subarray(offset, offset + 12);
    const tag = sealed.subarray(offset + 12, offset + 28);
    const ciphertext = sealed.subarray(offset + 28);
    const dek = await this.kek.unwrap(kid, wrapped, aad);
    try {
      return gcmOpen(dek, iv, tag, ciphertext, aad);
    } finally {
      dek.fill(0);
    }
  }
}

/**
 * Build the configured encryptor. Production requires KMS, whose provider is part of the
 * provider-credential milestone (M3); until then production startup fails closed here, as a
 * ConfigError so web and worker exit with EX_CONFIG (78) instead of serving errors.
 */
export function createEncryptor(config: RelayConfig): EnvelopeEncryptor {
  if (config.encryption.provider === 'kms') {
    throw new ConfigError([
      'RELAY_ENCRYPTION_PROVIDER=kms is required in production, but the KMS key provider ships with the provider-credential milestone (M3). Refusing to start rather than storing secrets under a local key.',
    ]);
  }
  return new EnvelopeEncryptor(new LocalKeyringProvider(config.encryption.keyring));
}
