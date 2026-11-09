import { NextResponse } from 'next/server';
import { checkDatabase, REQUIRED_SCHEMA_VERSION } from '@relay/db';
import { webContext } from '@/lib/server/context';

/** Readiness: database reachable at a compatible schema version and storage reachable. */
export async function GET() {
  const checks: Record<string, string> = {};
  let ok = true;
  try {
    const ctx = webContext();
    const { schemaVersion } = await checkDatabase(ctx.db);
    checks.database =
      schemaVersion && schemaVersion >= REQUIRED_SCHEMA_VERSION
        ? 'ok'
        : `schema ${schemaVersion ?? 'missing'} < ${REQUIRED_SCHEMA_VERSION}`;
    if (checks.database !== 'ok') ok = false;
    try {
      await ctx.storage.ping();
      checks.storage = 'ok';
    } catch {
      checks.storage = 'unreachable';
      ok = false;
    }
  } catch {
    checks.database = 'unreachable';
    ok = false;
  }
  return NextResponse.json(
    { ok, checks },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
