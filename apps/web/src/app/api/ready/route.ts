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
    { ok, checks },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
