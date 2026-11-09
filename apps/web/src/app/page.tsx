import { redirect } from 'next/navigation';
import { listMyWorkspaces } from '@relay/services';
import { webContext } from '@/lib/server/context';
import { requireSession } from '@/lib/server/session';
import { CreateWorkspace } from '@/components/shell/CreateWorkspace';
import { Wordmark } from '@relay/ui';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await requireSession();
  const workspaces = await listMyWorkspaces(webContext(), session.user);
  if (workspaces.length > 0) redirect(`/w/${workspaces[0]!.slug}/inbox`);
  return (
    <main id="main" className="auth-panel">
      <Wordmark />
      <h1>Create your first workspace</h1>
      <p className="r-muted">
        You are signed in as {session.user.email} but are not a member of any workspace yet. Ask an
        owner for an invitation, or create one.
      </p>
      <CreateWorkspace />
    </main>
  );
}
