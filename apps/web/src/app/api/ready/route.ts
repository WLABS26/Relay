import { NextResponse } from 'next/server';
import { checkDatabase, REQUIRED_SCHEMA_VERSION } from '@relay/db';
import { safeError } from '@relay/services';
import { webContext } from '@/lib/server/context';

/**
 * Readiness: database reachable at a compatible schema version and storage reachable.
 * Failure causes are logged server-side only; the response never includes them.
 */
export async function GET() {
  const checks: Record<string, string> = {};
  // Where this function runs and how long one database round trip takes: the two numbers that
  // explain a slow deployment (a database in another region costs that latency on every query).
  const timings: Record<string, number> = {};
  let ok = true;
  try {
    const ctx = webContext();
    let started = performance.now();
    const { schemaVersion } = await checkDatabase(ctx.db);
    timings.databaseFirstMs = Math.round(performance.now() - started);
    started = performance.now();
    await checkDatabase(ctx.db);
    timings.databaseRoundTripMs = Math.round(performance.now() - started);
    checks.database =
      schemaVersion && schemaVersion >= REQUIRED_SCHEMA_VERSION
        ? 'ok'
        : `schema ${schemaVersion ?? 'missing'} < ${REQUIRED_SCHEMA_VERSION}`;
    if (checks.database !== 'ok') ok = false;
    try {
      started = performance.now();
      await ctx.storage.ping();
      timings.storageMs = Math.round(performance.now() - started);
      checks.storage = 'ok';
    } catch (error) {
      // The probe answers tersely; the cause goes to the server log for operators.
      ctx.logger.warn({ err: safeError(error) }, 'readiness: storage unreachable');
      checks.storage = 'unreachable';
      ok = false;
    }
  } catch (error) {
    console.error('[relay-web] readiness: database unreachable', safeError(error));
    checks.database = 'unreachable';
    ok = false;
  }
  return NextResponse.json(
    { ok, checks, timings, functionRegion: process.env.VERCEL_REGION ?? null },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
