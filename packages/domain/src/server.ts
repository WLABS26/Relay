import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, type PublishIntentPayload } from './publishing/intent';

/**
 * Server-only helpers (node:crypto). Import from "@relay/domain/server", never from client
 * components.
 */

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Bytes(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

/** Hash of the normalised publish intent; approvals and schedules compare these. */
export function intentHash(payload: PublishIntentPayload): string {
  return sha256Hex(canonicalJson(payload));
}

/** Fingerprint of an arbitrary request payload (idempotency, provider request records). */
export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hmacSha256(secret: string | Buffer, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Constant-time comparison of two strings/buffers of possibly different length. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (ba.length !== bb.length) {
    // Compare against itself to keep timing independent of where lengths differ.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** URL-safe random token with `bytes` of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export { canonicalJson };
