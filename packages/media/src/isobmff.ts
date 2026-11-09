import { open } from 'node:fs/promises';

/**
 * Minimal ISO-BMFF (MP4/MOV) box walker used to detect content protection. ffprobe resolves
 * protected sample entries to their original format (an encrypted file still reports "avc1"),
 * so Relay inspects the box tree itself: protected sample entries (encv/enca/...), PSSH DRM
 * boxes and sample-encryption boxes in fragments all mark a file as encrypted.
 *
 * Only box headers and the bounded contents of container boxes are read. Sizes are validated
 * and one budget (box count, nesting depth, container size) covers the whole scan, so a
 * hostile file can neither loop the walker nor make it allocate or iterate without bound.
 * Whenever a limit stops inspection the scan reports `complete: false`.
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'sinf', 'schi']);
const PROTECTED_ENTRIES = new Set(['encv', 'enca', 'enct', 'encs', 'drmi', 'drms']);
const PROTECTION_BOXES = new Set(['pssh', 'senc', 'tenc']);

export const ISOBMFF_LIMITS = {
  /** Largest container payload read into memory for inspection. */
  maxContainerBytes: 64 * 1024 * 1024,
  /** Total boxes and sample entries visited across the whole file. */
  maxBoxes: 200_000,
  maxDepth: 16,
} as const;

export interface ProtectionScan {
  encrypted: boolean;
  /**
   * False when part of the box tree could not be inspected (a container larger than the
   * inspection bound, nesting deeper than the bound, or the box budget ran out). Callers must
   * not treat an incomplete scan as proof that a file is unprotected.
   */
  complete: boolean;
  markers: string[];
  boxesVisited: number;
}

interface ScanState {
  markers: Set<string>;
  visited: number;
  complete: boolean;
}

/** Count one box against the shared budget; false (and incomplete) once it is spent. */
function take(state: ScanState): boolean {
  if (state.visited >= ISOBMFF_LIMITS.maxBoxes) {
    state.complete = false;
    return false;
  }
  state.visited++;
  return true;
}

export async function scanIsoBmffProtection(path: string): Promise<ProtectionScan> {
  const handle = await open(path, 'r');
  const state: ScanState = { markers: new Set(), visited: 0, complete: true };
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(16);

    // Walk top-level boxes by reading headers only.
    let offset = 0;
    while (offset + 8 <= fileSize) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) break; // the 64-bit size itself is truncated
        const big = header.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
        boxSize = Number(big);
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = fileSize - offset;
      }
      if (boxSize < headerLen || offset + boxSize > fileSize) break; // truncated/corrupt: stop safely
      if (!take(state)) break;
      if (PROTECTION_BOXES.has(type)) state.markers.add(type);
      if (CONTAINERS.has(type)) {
        const payloadLen = boxSize - headerLen;
        if (payloadLen <= ISOBMFF_LIMITS.maxContainerBytes) {
          const payload = Buffer.alloc(payloadLen);
          await handle.read(payload, 0, payloadLen, offset + headerLen);
          walk(payload, state, 1);
        } else {
          state.markers.add(`oversized:${type}`);
          state.complete = false;
        }
      }
      offset += boxSize;
    }
  } finally {
    await handle.close();
  }
  const markers = [...state.markers].sort();
  const encrypted = markers.some((m) => PROTECTED_ENTRIES.has(m) || PROTECTION_BOXES.has(m));
  return { encrypted, complete: state.complete, markers, boxesVisited: state.visited };
}

function walk(buf: Buffer, state: ScanState, depth: number): void {
  if (depth > ISOBMFF_LIMITS.maxDepth) {
    state.markers.add('too_deep');
    state.complete = false;
    return;
  }
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerLen = 8;
    if (size === 1) {
      if (offset + 16 > buf.length) break;
      const big = buf.readBigUInt64BE(offset + 8);
      if (big > BigInt(buf.length)) break;
      size = Number(big);
      headerLen = 16;
    } else if (size === 0) {
      size = buf.length - offset;
    }
    if (size < headerLen || offset + size > buf.length) break;
    if (!take(state)) return;
    if (PROTECTION_BOXES.has(type)) state.markers.add(type);
    if (type === 'stsd') {
      // FullBox (4 bytes version/flags) + entry_count (4 bytes), then sample entries.
      const body = buf.subarray(offset + headerLen + 8, offset + size);
      let entryOffset = 0;
      while (entryOffset + 8 <= body.length) {
        const entrySize = body.readUInt32BE(entryOffset);
        const entryType = body.toString('latin1', entryOffset + 4, entryOffset + 8);
        if (entrySize < 8 || entryOffset + entrySize > body.length) break;
        if (!take(state)) return;
        if (PROTECTED_ENTRIES.has(entryType)) state.markers.add(entryType);
        entryOffset += entrySize;
      }
    } else if (CONTAINERS.has(type)) {
      walk(buf.subarray(offset + headerLen, offset + size), state, depth + 1);
    }
    offset += size;
  }
}
