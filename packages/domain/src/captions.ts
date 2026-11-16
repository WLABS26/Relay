import { AppError } from './errors';

/**
 * Caption cues for the clip editor: SRT/WebVTT import, validation, and the ASS file the
 * renderer burns in.
 *
 * Cues are stored on the SOURCE timeline (milliseconds, `startMs` inclusive, `endMs` exclusive),
 * so trimming a clip never rewrites them; `cuesForRender` maps them onto the clip timeline at
 * render time. User text reaches FFmpeg only through `toAss`, which rebuilds the whole file from
 * Relay's own tokens: an uploaded subtitle file is always parsed and re-serialised, never passed
 * through (spec 6.3).
 */

export interface Cue {
  startMs: number;
  endMs: number;
  /** Plain text, lines separated by `\n`. Never contains markup. */
  text: string;
}

export const CAPTION_MAX_INPUT_BYTES = 200 * 1024;
export const CAPTION_MAX_CUES = 500;
export const CAPTION_MAX_LINES = 2;
export const CAPTION_MAX_LINE_CHARS = 42;
export const CAPTION_MIN_CUE_MS = 300;

export type CaptionStyle = 'default';
/** Family name of the font bundled with the worker image; the renderer never falls back. */
export const CAPTION_FONT_FAMILY = 'Inter';

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/**
 * Parse failure. `fieldErrors` is keyed `captions.<index>` with the zero-based index of the cue
 * in the file, the same addressing `validateCues` uses, so the editor can point at the block.
 */
function parseError(message: string, cueIndex?: number): AppError {
  const key = cueIndex === undefined ? 'captions' : `captions.${cueIndex}`;
  return new AppError('validation_failed', message, {
    fieldErrors: { [key]: [message] },
    ...(cueIndex === undefined ? {} : { details: { cueIndex } }),
  });
}

/** Split into blocks of consecutive non-empty lines, after removing the BOM and CR. */
function blocksOf(input: string): string[][] {
  if (
    input.length > CAPTION_MAX_INPUT_BYTES ||
    new TextEncoder().encode(input).length > CAPTION_MAX_INPUT_BYTES
  ) {
    throw new AppError('payload_too_large', 'Caption file is larger than 200 KiB', {
      fieldErrors: { captions: ['Caption file is larger than 200 KiB'] },
    });
  }
  const text = input.replace(/^\u{FEFF}/u, '').replace(/\r\n?/g, '\n');
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

const SRT_TIME = /^(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{3})$/;
const VTT_TIME = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;

function timeToMs(token: string, pattern: RegExp): number | null {
  const match = pattern.exec(token);
  if (!match) return null;
  const [, hours = '0', minutes = '0', seconds = '0', millis = '0'] = match;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(millis);
}

/**
 * `start --> end [settings]`. Anything after the end timestamp (VTT cue settings, SRT
 * coordinates) is positioning we do not honour, so it is dropped.
 */
function parseTiming(line: string, pattern: RegExp): { startMs: number; endMs: number } | null {
  const [left, right, ...rest] = line.split('-->');
  if (left === undefined || right === undefined || rest.length > 0) return null;
  const startMs = timeToMs(left.trim(), pattern);
  const endMs = timeToMs(right.trim().split(/[ \t]+/)[0] ?? '', pattern);
  return startMs === null || endMs === null ? null : { startMs, endMs };
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  // Directional marks would be rejected by validateCues; they carry no visible text.
  '&lrm;': '',
  '&rlm;': '',
};

/**
 * Remove every `open ... close` span. A scan rather than a regular expression: `/<[^>]*>/g` is
 * quadratic on a line of unclosed `<`, and a 200 KiB file of them blocked the thread for seconds.
 */
function stripSpans(line: string, open: string, close: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const from = line.indexOf(open, at);
    const to = from < 0 ? -1 : line.indexOf(close, from + open.length);
    // No closing delimiter after this opener means none after any later opener either.
    if (to < 0) return out + line.slice(at);
    out += line.slice(at, from);
    at = to + close.length;
  }
}

/**
 * Markup-free cue text. `<...>` covers SRT's `<i>`/`<font>` and every VTT span, voice and
 * timestamp tag; `{\...}` covers the ASS override blocks some SRT tools emit. Entities are
 * decoded after stripping so that `&lt;b&gt;` stays literal text.
 */
function cleanText(lines: string[], format: 'srt' | 'vtt'): string {
  return lines
    .map((line) => {
      let out = stripSpans(line, '<', '>');
      if (format === 'srt') out = stripSpans(out, '{\\', '}');
      else out = out.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (entity) => ENTITIES[entity] ?? '');
      return out.trim();
    })
    .filter((line) => line !== '')
    .join('\n')
    .normalize('NFC');
}

function parseBlocks(blocks: string[][], format: 'srt' | 'vtt'): Cue[] {
  const pattern = format === 'srt' ? SRT_TIME : VTT_TIME;
  const cues: Cue[] = [];
  // Counts every cue block in the file, including ones later dropped for having no text, so
  // the index in an error matches what the user sees when they open the file.
  let index = 0;
  for (const block of blocks) {
    // The timing line is the first line, or the second when the block has an identifier.
    const timingAt = block.findIndex((line) => line.includes('-->'));
    if (timingAt < 0 || timingAt > 1) {
      throw parseError(`Cue ${index + 1} has no timing line`, index);
    }
    const timing = parseTiming(block[timingAt] ?? '', pattern);
    if (!timing) {
      throw parseError(`Cue ${index + 1} has a malformed timecode`, index);
    }
    const text = cleanText(block.slice(timingAt + 1), format);
    if (text !== '') cues.push({ ...timing, text });
    index += 1;
    if (index > CAPTION_MAX_CUES * 4) {
      // Bounds work on hostile input; validateCues reports the real limit for honest files.
      throw parseError('Caption file has too many cues');
    }
  }
  return cues;
}

/** Parse SubRip. Throws `validation_failed` naming the cue on a malformed block. */
export function parseSrt(text: string): Cue[] {
  return parseBlocks(blocksOf(text), 'srt');
}

/** Parse WebVTT. NOTE, STYLE and REGION blocks, cue settings and all tags are dropped. */
export function parseVtt(text: string): Cue[] {
  const blocks = blocksOf(text);
  const header = blocks[0]?.[0];
  if (header === undefined || !/^WEBVTT(?:[ \t]|$)/.test(header)) {
    throw parseError('A WebVTT file must start with WEBVTT');
  }
  // A cue glued to the header block (no blank line between) would otherwise vanish silently.
  if (blocks[0]?.some((line) => line.includes('-->'))) {
    throw parseError('A blank line must follow the WebVTT header');
  }
  const cueBlocks = blocks
    .slice(1)
    .filter((block) => !/^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block[0] ?? ''));
  return parseBlocks(cueBlocks, 'vtt');
}

/** Import option "times start at the clip start": move file-relative cues onto the source timeline. */
export function shiftCues(cues: readonly Cue[], offsetMs: number): Cue[] {
  return cues.map((cue) => ({
    startMs: cue.startMs + offsetMs,
    endMs: cue.endMs + offsetMs,
    text: cue.text,
  }));
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/**
 * Code points that have no place in a caption: C0/C1 controls (tab included; the only line
 * break is `\n`, split off before this test), every format character (bidirectional overrides
 * and isolates, zero-width characters, BOM, soft hyphen, tag characters), line and paragraph
 * separators, unpaired surrogates, noncharacters, and the fillers that render as nothing
 * (U+034F, U+115F, U+1160, U+2800, U+3164, U+FFA0). They can make burned-in text read differently from
 * what the reviewer approved.
 */
const FORBIDDEN_CODE_POINT =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Noncharacter_Code_Point}\u{034F}\u{115F}\u{1160}\u{2800}\u{3164}\u{FFA0}]/u;

type Segmenter = { segment(input: string): Iterable<unknown> };
const graphemes: Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Length as a reader counts it: user-perceived characters, not UTF-16 units. */
function visibleLength(line: string): number {
  let count = 0;
  for (const _ of graphemes ? graphemes.segment(line) : line) count += 1;
  return count;
}

function describeCodePoint(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

export type CueValidation =
  { ok: true; cues: Cue[] } | { ok: false; fieldErrors: Record<string, string[]> };

export interface CueValidationRange {
  clipStartMs: number;
  clipEndMs: number;
}

/**
 * Validate an editable subtitle track (spec 6.5). On success the returned cues are the ones to
 * store: text is NFC-normalised with `\n` line breaks. Errors are keyed like the request body
 * (`captions.3.text`, `captions.3.startMs`).
 *
 * Cues outside `[clipStartMs, clipEndMs)` are allowed, because cues live on the source timeline
 * and must survive a trim. A cue that straddles a clip edge must still be on screen for the
 * minimum cue length, otherwise the render would flash it for a few frames.
 */
export function validateCues(cues: readonly Cue[], range: CueValidationRange): CueValidation {
  const fieldErrors: Record<string, string[]> = {};
  const add = (key: string, message: string) => {
    (fieldErrors[key] ??= []).push(message);
  };

  if (cues.length > CAPTION_MAX_CUES) {
    add('captions', `At most ${CAPTION_MAX_CUES} cues`);
    return { ok: false, fieldErrors };
  }

  const normalised: Cue[] = [];
  let previous: Cue | undefined;
  cues.forEach((cue, i) => {
    const at = `captions.${i}`;
    const timesValid =
      Number.isSafeInteger(cue.startMs) && Number.isSafeInteger(cue.endMs) && cue.startMs >= 0;
    if (!timesValid) {
      add(`${at}.startMs`, 'Times must be whole milliseconds from 0');
    } else if (cue.endMs <= cue.startMs) {
      add(`${at}.endMs`, 'Must end after it starts');
    } else {
      if (cue.endMs - cue.startMs < CAPTION_MIN_CUE_MS) {
        add(`${at}.endMs`, `Must last at least ${CAPTION_MIN_CUE_MS} ms`);
      } else {
        const visible =
          Math.min(cue.endMs, range.clipEndMs) - Math.max(cue.startMs, range.clipStartMs);
        if (visible > 0 && visible < CAPTION_MIN_CUE_MS) {
          add(
            cue.startMs < range.clipStartMs ? `${at}.endMs` : `${at}.startMs`,
            `Only ${visible} ms of this cue is inside the clip; at least ${CAPTION_MIN_CUE_MS} ms must be`,
          );
        }
      }
      if (previous) {
        if (cue.startMs < previous.startMs) add(`${at}.startMs`, 'Out of order');
        else if (cue.startMs < previous.endMs) add(`${at}.startMs`, 'Overlaps the previous cue');
      }
      previous = cue;
    }

    const text = typeof cue.text === 'string' ? cue.text.replace(/\r\n?/g, '\n') : '';
    const lines = text.split('\n');
    const forbidden = lines.map((line) => FORBIDDEN_CODE_POINT.exec(line)?.[0]).find(Boolean);
    if (text.trim() === '') {
      add(`${at}.text`, 'Required');
    } else if (forbidden !== undefined) {
      add(
        `${at}.text`,
        `Contains a control or invisible character (${describeCodePoint(forbidden)})`,
      );
    } else {
      const clean = text.normalize('NFC').split('\n');
      if (clean.some((line) => line.trim() === '')) add(`${at}.text`, 'Remove the empty line');
      if (clean.length > CAPTION_MAX_LINES) add(`${at}.text`, `At most ${CAPTION_MAX_LINES} lines`);
      if (clean.some((line) => visibleLength(line) > CAPTION_MAX_LINE_CHARS)) {
        add(`${at}.text`, `At most ${CAPTION_MAX_LINE_CHARS} characters per line`);
      }
      normalised.push({ startMs: cue.startMs, endMs: cue.endMs, text: clean.join('\n') });
    }
  });

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, cues: normalised };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/**
 * Cues on the clip timeline (0 = first rendered frame): shifted by `-startMs`, cut at the clip
 * edges, and dropped when nothing of them is left.
 */
export function cuesForRender(cues: readonly Cue[], startMs: number, endMs: number): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const from = Math.max(cue.startMs, startMs) - startMs;
    const to = Math.min(cue.endMs, endMs) - startMs;
    if (to > from && cue.text.trim() !== '') out.push({ startMs: from, endMs: to, text: cue.text });
  }
  return out;
}

export interface AssOptions {
  /** Output frame size in pixels; the script resolution, so every style value is in pixels. */
  width: number;
  height: number;
  style: CaptionStyle;
}

/** `H:MM:SS.cc`; ASS times have centisecond resolution. */
function assTime(centiseconds: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  return `${Math.floor(totalSeconds / 3600)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * Cue text as an ASS Dialogue field with nothing in it that libass interprets.
 *
 * ASS has no escape for a backslash, and `\N`, `\n`, `\h` are active even outside an override
 * block. So every backslash from the user is followed by U+2060 WORD JOINER, which libass's
 * shaper skips: the backslash is then never directly in front of a letter or brace and is drawn
 * literally. Braces are written `\{` and `\}`, the escapes libass provides for them, so no `{`
 * can open an override block. Line breaks become `\N`; any other control or separator is
 * removed so text can never start a new line (a new `Dialogue:` or section) in the file.
 */
function assText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[\p{Cc}\p{Zl}\p{Zp}\u{2060}]/gu, '')
        .trim()
        .replace(/[\\{}]/g, (char) => (char === '\\' ? '\\\u{2060}' : `\\${char}`)),
    )
    .filter((line) => line !== '')
    .join('\\N');
}

/**
 * Build the complete ASS file for burned-in captions. `cues` are on the clip timeline (see
 * `cuesForRender`). Everything except the Dialogue text is a Relay constant or a number.
 */
export function toAss(cues: readonly Cue[], options: AssOptions): string {
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('toAss needs positive integer dimensions');
  }
  // Proportional to height, but capped by width so a 42-character line still fits a 9:16 frame
  // on one row (Inter averages about half an em per character).
  const fontSize = Math.max(12, Math.min(Math.round(height * 0.05), Math.floor(width / 26)));
  const outline = Math.max(1, Math.round(fontSize / 14));
  const marginH = Math.round(width * 0.05);
  // Above the bottom tenth of the frame, clear of platform UI on vertical video.
  const marginV = Math.round(height * 0.1);

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${CAPTION_FONT_FAMILY},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const cue of cues) {
    const text = assText(cue.text);
    const start = Math.max(0, Math.round(cue.startMs / 10));
    const end = Math.round(cue.endMs / 10);
    if (text === '' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  return `${lines.join('\n')}\n`;
}
