import type { Metadata } from 'next';
import { Wordmark } from '@relay/ui';
import { AcceptInvitation } from '@/components/settings/MemberForms';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Accept invitation' };
export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await requireSession();
  return (
    <main id="main" className="auth-panel">
      <Wordmark />
      <h1>Join a workspace</h1>
      <p className="r-muted">You are signed in as {session.user.email}. The invitation must have been sent to this address.</p>
      <AcceptInvitation token={decodeURIComponent(token)} />
    </main>
  );
}
