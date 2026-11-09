import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ISOBMFF_LIMITS, scanIsoBmffProtection } from './isobmff';

/** Build an ISO-BMFF box: 32-bit size + 4-char type + payload. */
function box(type: string, ...children: Buffer[]): Buffer {
  const payload = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}
/** A sample description box holding sample entries of the given types. */
function stsd(...entryTypes: string[]): Buffer {
  const fullBox = Buffer.alloc(8); // version/flags + entry_count
  fullBox.writeUInt32BE(entryTypes.length, 4);
  return box('stsd', fullBox, ...entryTypes.map((t) => box(t, Buffer.alloc(78))));
}
const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1'));
const track = (...entries: string[]) => box('trak', box('mdia', box('minf', box('stbl', stsd(...entries)))));

const dir = mkdtempSync(path.join(tmpdir(), 'relay-isobmff-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
async function scan(...topLevel: Buffer[]) {
  const file = path.join(dir, `f${n++}.mp4`);
  writeFileSync(file, Buffer.concat(topLevel));
  return scanIsoBmffProtection(file);
}

describe('scanIsoBmffProtection', () => {
  it('passes an ordinary file and inspects it completely', async () => {
    const r = await scan(ftyp, box('moov', track('avc1'), track('mp4a')), box('mdat', Buffer.alloc(64)));
    expect(r).toMatchObject({ encrypted: false, complete: true, markers: [] });
    expect(r.boxesVisited).toBeGreaterThan(10);
  });

  it('finds protected sample entries that ffprobe reports as their original codec', async () => {
    expect(await scan(ftyp, box('moov', track('encv')))).toMatchObject({ encrypted: true, markers: ['encv'] });
    expect((await scan(ftyp, box('moov', track('avc1'), track('enca')))).markers).toEqual(['enca']);
  });

  it('finds DRM and sample-encryption boxes, including inside fragments', async () => {
    expect((await scan(ftyp, box('moov', box('pssh', Buffer.alloc(24)), track('avc1')))).markers).toEqual(['pssh']);
    const fragment = box('moof', box('traf', box('senc', Buffer.alloc(16))));
    expect(await scan(ftyp, box('moov', track('avc1')), fragment, box('mdat'))).toMatchObject({ encrypted: true, markers: ['senc'] });
  });

  it('stops safely on truncated and corrupt sizes', async () => {
    const huge = Buffer.alloc(8);
    huge.writeUInt32BE(0xffffff00, 0);
    huge.write('moov', 4, 'latin1');
    expect(await scan(ftyp, huge)).toMatchObject({ encrypted: false, boxesVisited: 1 });
    const zeroSize = Buffer.from([0, 0, 0, 4, ...Buffer.from('free')]); // size smaller than its header
    expect((await scan(ftyp, zeroSize)).boxesVisited).toBe(1);
    const largesizeCut = Buffer.from([0, 0, 0, 1, ...Buffer.from('mdat'), 0, 0]); // 64-bit size missing
    expect((await scan(ftyp, largesizeCut)).boxesVisited).toBe(1);
  });

  it('reports an incomplete scan instead of a clean one when nesting exceeds the bound', async () => {
    let nested = track('encv');
    for (let i = 0; i < ISOBMFF_LIMITS.maxDepth + 2; i++) nested = box('trak', nested);
    const r = await scan(ftyp, box('moov', nested));
    expect(r.complete).toBe(false);
    expect(r.markers).toContain('too_deep');
  });

  it('spends one box budget across the whole file', async () => {
    // Many tiny boxes spread across several containers: the budget is global, not per container.
    const perContainer = Math.ceil(ISOBMFF_LIMITS.maxBoxes / 4) + 10;
    const filler = Buffer.concat(Array.from({ length: perContainer }, () => box('free')));
    const r = await scan(ftyp, box('moov', box('trak', filler), box('trak', filler), box('trak', filler), box('trak', filler)));
    expect(r.complete).toBe(false);
    expect(r.boxesVisited).toBeLessThanOrEqual(ISOBMFF_LIMITS.maxBoxes);
  });
});
