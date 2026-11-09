import { NextResponse } from 'next/server';

/** Liveness: the process is up. No dependencies are touched. */
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
