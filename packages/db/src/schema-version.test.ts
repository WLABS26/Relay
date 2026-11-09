import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_SCHEMA_VERSION } from './schema-version';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('migrations', () => {
  it('are numbered 0001… without gaps or duplicates', () => {
    expect(migrations.length).toBeGreaterThan(0);
    migrations.forEach((file, i) => {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(file.slice(0, 4)).toBe(String(i + 1).padStart(4, '0'));
    });
  });

  it('match the schema version this build requires (web and worker refuse older databases)', () => {
    expect(REQUIRED_SCHEMA_VERSION).toBe(migrations.at(-1)!.slice(0, 4));
  });
});
