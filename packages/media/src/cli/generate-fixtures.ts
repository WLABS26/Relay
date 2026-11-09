import path from 'node:path';
import { REPO_ROOT, loadDotEnv } from '@relay/config/dotenv';
import { generateFixtures } from '../fixtures';

loadDotEnv();
const outDir = path.join(REPO_ROOT, 'fixtures/media');
const started = Date.now();
const manifest = await generateFixtures({
  outDir,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
});
for (const f of manifest.files) {
  console.log(
    `${f.name.padEnd(30)} ${String(f.sizeBytes).padStart(9)} B  ${f.expect.valid ? 'valid' : `invalid (${f.expect.rejection})`}`,
  );
}
console.log(
  `[fixtures] wrote ${manifest.files.length} synthetic files to ${outDir} in ${Date.now() - started} ms`,
);
