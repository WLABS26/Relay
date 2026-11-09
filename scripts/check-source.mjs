#!/usr/bin/env node
/**
 * Source hygiene check (part of `pnpm lint`): fail on characters that make code read
 * differently from how it runs — Unicode bidirectional controls ("Trojan Source",
 * CVE-2021-42574), zero-width characters, and ASCII control bytes other than tab/newline.
 * Write such characters as escapes (for example a backslash-u escape such as \u202e) instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'test-results',
  'playwright-report',
  'fixtures',
]);
const EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.md',
  '.sql',
  '.yaml',
  '.yml',
  '.sh',
  '.svg',
  '.html',
  '.example',
]);
// Bidi controls, zero-width/invisible formatting characters, BOM, and C0/C1 controls except \t \n \r.
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060-\u2064\ufeff\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(path.join(dir, entry.name));
    } else if (EXTENSIONS.has(path.extname(entry.name)) || entry.name.startsWith('.env')) {
      yield path.join(dir, entry.name);
    }
  }
}

let problems = 0;
for (const file of files(root)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const match of line.matchAll(FORBIDDEN)) {
      const code = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      console.error(
        `${path.relative(root, file)}:${i + 1}:${match.index + 1}  forbidden invisible character U+${code}`,
      );
      problems++;
    }
  });
}
if (problems > 0) {
  console.error(`\n${problems} forbidden character(s). Use escape sequences instead.`);
  process.exit(1);
}
console.log('source check: no invisible or bidirectional control characters');
