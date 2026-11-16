import { describe, expect, it } from 'vitest';
import {
  CAPTION_FONT_FAMILY,
  CAPTION_MAX_CUES,
  CAPTION_MAX_INPUT_BYTES,
  cuesForRender,
  parseSrt,
  parseVtt,
  shiftCues,
  toAss,
  validateCues,
  type Cue,
} from './captions';
import { AppError } from './errors';

const RANGE = { clipStartMs: 0, clipEndMs: 60_000 };

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:02,500',
  'Hello <i>there</i>',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,200 X1:40 X2:600',
  '{\\an8}Second cue',
  '<font color="#fff">two lines</font>',
  '',
].join('\n');

const VTT = [
  'WEBVTT - demo',
  '',
  'NOTE this block is a comment',
  'spanning two lines',
  '',
  'STYLE',
  '::cue { color: red }',
  '',
  'REGION',
  'id:fred',
  '',
  'intro',
  '00:00:01.000 --> 00:00:02.500 line:0 position:20% align:start',
  '<v Roger>Hello <b>there</b>',
  '',
  '00:00:03.000 --> 00:00:04.200',
  'Second cue',
  '<c.loud>two <00:00:03.500>lines</c>',
  '',
].join('\n');

const EXPECTED: Cue[] = [
  { startMs: 1000, endMs: 2500, text: 'Hello there' },
  { startMs: 3000, endMs: 4200, text: 'Second cue\ntwo lines' },
];

function fieldErrorsOf(run: () => unknown): Record<string, string[]> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).fieldErrors ?? {};
  }
  throw new Error('expected the parser to throw');
}

function errorsOf(cues: Cue[], range = RANGE): Record<string, string[]> {
  const result = validateCues(cues, range);
  if (result.ok) throw new Error('expected validation to fail');
  return result.fieldErrors;
}

describe('parseSrt / parseVtt', () => {
  it('parses SRT, dropping tags, override blocks and coordinates', () => {
    expect(parseSrt(SRT)).toEqual(EXPECTED);
  });

  it('parses VTT, dropping NOTE/STYLE/REGION blocks, identifiers, settings and tags', () => {
    expect(parseVtt(VTT)).toEqual(EXPECTED);
  });

  it('round trip: the SRT and VTT forms of a track give cues that validate unchanged', () => {
    const fromSrt = parseSrt(SRT);
    expect(parseVtt(VTT)).toEqual(fromSrt);
    expect(validateCues(fromSrt, RANGE)).toEqual({ ok: true, cues: fromSrt });
  });

  it('accepts a BOM and CRLF line endings', () => {
    const crlf = (text: string) => `\u{FEFF}${text.replace(/\n/g, '\r\n')}`;
    expect(parseSrt(crlf(SRT))).toEqual(EXPECTED);
    expect(parseVtt(crlf(VTT))).toEqual(EXPECTED);
  });

  it('accepts VTT timestamps with and without hours', () => {
    const cues = parseVtt(
      'WEBVTT\n\n00:59.500 --> 01:00:01.250\nA\n\n100:00:00.000 --> 100:00:01.000\nB',
    );
    expect(cues).toEqual([
      { startMs: 59_500, endMs: 3_601_250, text: 'A' },
      { startMs: 360_000_000, endMs: 360_001_000, text: 'B' },
    ]);
  });

  it('decodes VTT entities only after stripping tags', () => {
    expect(
      parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nR&amp;D &lt;b&gt;&nbsp;ok&lrm;')[0]?.text,
    ).toBe('R&D <b> ok');
  });

  it('normalises text to NFC', () => {
    expect(parseSrt('1\n00:00:01,000 --> 00:00:02,000\nCafe\u{0301}')[0]?.text).toBe('Caf\u{00E9}');
  });

  it('drops cues left empty once markup is removed', () => {
    expect(
      parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n\n2\n00:00:03,000 --> 00:00:04,000\nB'),
    ).toEqual([{ startMs: 3000, endMs: 4000, text: 'B' }]);
  });

  it.each([
    ['minutes out of range', '00:61:00,000 --> 00:00:02,000'],
    ['missing milliseconds', '00:00:01 --> 00:00:02,000'],
    ['two arrows', '00:00:01,000 --> 00:00:02,000 --> 00:00:03,000'],
    ['not a time', 'soon --> later'],
  ])('rejects a malformed SRT timecode with the cue index (%s)', (_name, timing) => {
    const text = `1\n00:00:01,000 --> 00:00:02,000\nfine\n\n2\n${timing}\nbroken`;
    const errors = fieldErrorsOf(() => parseSrt(text));
    expect(Object.keys(errors)).toEqual(['captions.1']);
    expect(errors['captions.1']?.[0]).toMatch(/Cue 2 .*timecode/);
  });

  it('rejects a malformed VTT timecode with the cue index', () => {
    // A comma is SRT syntax; WebVTT requires a full stop.
    const errors = fieldErrorsOf(() => parseVtt('WEBVTT\n\n00:00:01,000 --> 00:00:02,000\nx'));
    expect(Object.keys(errors)).toEqual(['captions.0']);
  });

  it('rejects a block without a timing line and a VTT file without its header', () => {
    expect(Object.keys(fieldErrorsOf(() => parseSrt('1\njust text')))).toEqual(['captions.0']);
    expect(Object.keys(fieldErrorsOf(() => parseVtt(SRT)))).toEqual(['captions']);
    expect(Object.keys(fieldErrorsOf(() => parseVtt('WEBVTTX\n')))).toEqual(['captions']);
  });

  it('refuses input over 200 KiB before parsing', () => {
    const big = `1\n00:00:01,000 --> 00:00:02,000\n${'a'.repeat(CAPTION_MAX_INPUT_BYTES)}`;
    expect(() => parseSrt(big)).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' }),
    );
    // Counted in bytes, not UTF-16 units.
    const wide = '\u{00E9}'.repeat(CAPTION_MAX_INPUT_BYTES / 2 + 1);
    expect(() => parseVtt(`WEBVTT\n\n${wide}`)).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' }),
    );
  });

  it('strips markup in linear time on a line of unclosed delimiters', () => {
    // Each of these took 8-17 s with regular expressions; the default 5 s test timeout guards it.
    const head = '1\n00:00:01,000 --> 00:00:02,000\n';
    const angles = '<'.repeat(190_000);
    const braces = '{\\'.repeat(95_000);
    expect(parseSrt(head + angles)[0]?.text).toBe(angles);
    expect(parseSrt(head + braces)[0]?.text).toBe(braces);
    expect(parseVtt(`WEBVTT\n\n00:01.000 --> 00:02.000\n${angles}`)[0]?.text).toBe(angles);
    expect(parseSrt(`${head}a <b>b</b> < c {\\i1}d{\\i0} {e} <`)[0]?.text).toBe('a b < c d {e} <');
  });

  it('rejects a VTT cue that is not separated from the header by a blank line', () => {
    expect(
      Object.keys(fieldErrorsOf(() => parseVtt('WEBVTT\n00:01.000 --> 00:02.000\nhi'))),
    ).toEqual(['captions']);
  });

  it('returns no cues for an empty file', () => {
    expect(parseSrt('')).toEqual([]);
    expect(parseVtt('WEBVTT')).toEqual([]);
  });

  it('shiftCues moves file-relative cues onto the source timeline', () => {
    expect(shiftCues(EXPECTED, 10_000)[1]).toEqual({
      startMs: 13_000,
      endMs: 14_200,
      text: 'Second cue\ntwo lines',
    });
  });
});

describe('validateCues', () => {
  const cue = (startMs: number, endMs: number, text = 'ok'): Cue => ({ startMs, endMs, text });

  it('accepts a well-formed track and returns NFC text with LF line breaks', () => {
    const result = validateCues([cue(0, 1000, 'Cafe\u{0301}\r\nline two'), cue(1000, 2000)], RANGE);
    expect(result).toEqual({
      ok: true,
      cues: [cue(0, 1000, 'Caf\u{00E9}\nline two'), cue(1000, 2000)],
    });
  });

  it('rejects overlap and out-of-order cues at the offending index', () => {
    expect(errorsOf([cue(0, 2000), cue(1500, 3000)])).toEqual({
      'captions.1.startMs': ['Overlaps the previous cue'],
    });
    expect(errorsOf([cue(5000, 6000), cue(1000, 2000)])).toEqual({
      'captions.1.startMs': ['Out of order'],
    });
  });

  it('rejects inverted, too-short, negative and fractional timings', () => {
    expect(Object.keys(errorsOf([cue(2000, 2000)]))).toEqual(['captions.0.endMs']);
    expect(Object.keys(errorsOf([cue(2000, 2299)]))).toEqual(['captions.0.endMs']);
    expect(Object.keys(errorsOf([cue(-1, 1000)]))).toEqual(['captions.0.startMs']);
    expect(Object.keys(errorsOf([cue(0.5, 1000)]))).toEqual(['captions.0.startMs']);
    expect(validateCues([cue(2000, 2300)], RANGE).ok).toBe(true);
  });

  it('rejects a 43-character line and a third line, and accepts 42 and two', () => {
    const line = (n: number) => 'x'.repeat(n);
    expect(validateCues([cue(0, 1000, `${line(42)}\n${line(42)}`)], RANGE).ok).toBe(true);
    expect(
      errorsOf([cue(0, 1000), cue(1000, 2000), cue(2000, 3000), cue(3000, 4000, line(43))]),
    ).toEqual({ 'captions.3.text': ['At most 42 characters per line'] });
    expect(errorsOf([cue(0, 1000, 'a\nb\nc')])).toEqual({
      'captions.0.text': ['At most 2 lines'],
    });
  });

  it('counts characters as a reader sees them, not UTF-16 units', () => {
    // 42 decomposable letters with no precomposed form, and 42 astral code points.
    expect(validateCues([cue(0, 1000, 'q\u{0301}'.repeat(42))], RANGE).ok).toBe(true);
    expect(validateCues([cue(0, 1000, '\u{1F600}'.repeat(42))], RANGE).ok).toBe(true);
  });

  it.each([
    ['right-to-left override', '\u{202E}'],
    ['left-to-right isolate', '\u{2066}'],
    ['zero-width space', '\u{200B}'],
    ['byte order mark', '\u{FEFF}'],
    ['NUL', '\u{0000}'],
    ['tab', '\t'],
    ['escape', '\u{001B}'],
    ['line separator', '\u{2028}'],
    ['Hangul filler', '\u{3164}'],
    ['braille blank', '\u{2800}'],
    ['noncharacter', '\u{FDD0}'],
    ['astral noncharacter', '\u{1FFFE}'],
    ['lone surrogate', '\u{D800}'],
  ])('rejects a %s in cue text', (_name, char) => {
    const errors = errorsOf([cue(0, 1000, `ab${char}cd`)]);
    expect(Object.keys(errors)).toEqual(['captions.0.text']);
    expect(errors['captions.0.text']?.[0]).toMatch(/U\+[0-9A-F]{4}/);
  });

  it('rejects empty text and empty lines', () => {
    expect(errorsOf([cue(0, 1000, '  ')])).toEqual({ 'captions.0.text': ['Required'] });
    expect(Object.keys(errorsOf([cue(0, 1000, 'a\n\nb')]))).toEqual(['captions.0.text']);
  });

  it('caps the track at 500 cues', () => {
    const many = Array.from({ length: CAPTION_MAX_CUES + 1 }, (_, i) =>
      cue(i * 1000, i * 1000 + 500),
    );
    expect(errorsOf(many, { clipStartMs: 0, clipEndMs: 1_000_000 })).toEqual({
      captions: ['At most 500 cues'],
    });
    expect(validateCues(many.slice(1), { clipStartMs: 0, clipEndMs: 1_000_000 }).ok).toBe(true);
  });

  it('keeps cues outside the clip but rejects one that would only flash at a clip edge', () => {
    const range = { clipStartMs: 10_000, clipEndMs: 20_000 };
    expect(validateCues([cue(1000, 2000), cue(9000, 10_300), cue(30_000, 31_000)], range).ok).toBe(
      true,
    );
    expect(Object.keys(errorsOf([cue(9000, 10_100)], range))).toEqual(['captions.0.endMs']);
    expect(Object.keys(errorsOf([cue(19_900, 21_000)], range))).toEqual(['captions.0.startMs']);
  });
});

describe('cuesForRender', () => {
  it('shifts to the clip timeline, clips a straddling cue and drops cues outside the range', () => {
    const cues: Cue[] = [
      { startMs: 1000, endMs: 2000, text: 'before' },
      { startMs: 4000, endMs: 5000, text: 'ends at the inclusive start' },
      { startMs: 4500, endMs: 5500, text: 'straddles start' },
      { startMs: 6000, endMs: 7000, text: 'inside' },
      { startMs: 9500, endMs: 11_000, text: 'straddles end' },
      { startMs: 10_000, endMs: 12_000, text: 'starts at the exclusive end' },
    ];
    expect(cuesForRender(cues, 5000, 10_000)).toEqual([
      { startMs: 0, endMs: 500, text: 'straddles start' },
      { startMs: 1000, endMs: 2000, text: 'inside' },
      { startMs: 4500, endMs: 5000, text: 'straddles end' },
    ]);
  });
});

describe('toAss', () => {
  const options = { width: 1080, height: 1920, style: 'default' as const };
  const dialogueText = (text: string) => {
    const lines = toAss([{ startMs: 0, endMs: 1000, text }], options)
      .split('\n')
      .filter((line) => line.startsWith('Dialogue:'));
    expect(lines).toHaveLength(1);
    return (lines[0] ?? '').split(',').slice(9).join(',');
  };

  it('writes one fixed style sized from the frame and one Dialogue per cue', () => {
    const ass = toAss(
      [
        { startMs: 0, endMs: 1234, text: 'One, with a comma' },
        { startMs: 3_723_456, endMs: 3_724_000, text: 'Two\nlines' },
      ],
      options,
    );
    expect(ass).toContain('PlayResX: 1080\nPlayResY: 1920\n');
    // 5 % of the height would be 96 px; the width cap keeps a 42-character line on one row.
    expect(ass).toContain(`Style: Default,${CAPTION_FONT_FAMILY},41,`);
    expect(ass).toContain(',2,54,54,192,1\n');
    expect(ass.match(/^Style:/gm)).toHaveLength(1);
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.23,Default,,0,0,0,,One, with a comma\n');
    expect(ass).toContain('Dialogue: 0,1:02:03.46,1:02:04.00,Default,,0,0,0,,Two\\Nlines\n');
    expect(ass.endsWith('\n')).toBe(true);
  });

  it('sizes from the height on a landscape frame', () => {
    expect(toAss([], { width: 1920, height: 1080, style: 'default' })).toContain(
      `Style: Default,${CAPTION_FONT_FAMILY},54,`,
    );
  });

  it('escapes {\\an8} and backslashes so no override tag survives', () => {
    const text = dialogueText('{\\an8}top \\N \\h \\\\N C:\\new {\\pos(0,0)}');
    // Every brace is escaped, so nothing opens an override block.
    expect(text.replace(/\\[{}]/g, '')).not.toMatch(/[{}]/);
    // Every backslash is either a brace escape or followed by the word joiner libass skips,
    // never directly by a letter: no \N, \n, \h and no tag name.
    for (const match of text.matchAll(/\\(.)/gsu)) {
      expect(['{', '}', '\u{2060}']).toContain(match[1]);
    }
    expect(text).toBe(
      '\\{\\\u{2060}an8\\}top \\\u{2060}N \\\u{2060}h \\\u{2060}\\\u{2060}N C:\\\u{2060}new \\{\\\u{2060}pos(0,0)\\}',
    );
  });

  it('keeps text from starting a new line or section in the file', () => {
    const ass = toAss(
      [
        {
          startMs: 0,
          endMs: 1000,
          text: 'a\r\nDialogue: 0,0:00:00.00,9:00:00.00,Default,,0,0,0,,x\u{2028}[Events]\u{0085}\u{000B}b',
        },
      ],
      options,
    );
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
    expect(ass.match(/^\[/gm)).toHaveLength(3);
    // The only line terminators in the file are the LFs toAss wrote between its own lines.
    expect(ass.replace(/\n/g, '')).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
    expect(ass.split('\n')).toHaveLength(16);
  });

  it('drops a word joiner supplied by the user so it cannot pair with a backslash', () => {
    expect(dialogueText('a\u{2060}\\N')).toBe('a\\\u{2060}N');
  });

  it('skips cues that are empty or have no duration at centisecond resolution', () => {
    const ass = toAss(
      [
        { startMs: 0, endMs: 1000, text: ' \n ' },
        { startMs: 1000, endMs: 1004, text: 'too short' },
        { startMs: 2000, endMs: 3000, text: 'kept' },
      ],
      options,
    );
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
    expect(ass).toContain(',,kept\n');
  });

  it('rejects non-integer or non-positive dimensions', () => {
    expect(() => toAss([], { width: 0, height: 1080, style: 'default' })).toThrow(RangeError);
    expect(() => toAss([], { width: 1080.5, height: 1920, style: 'default' })).toThrow(RangeError);
  });
});
