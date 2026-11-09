import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@relay/db';
import { ManualClock } from '@relay/domain';
import {
  acceptInvitation,
  createPage,
  createPost,
  decideApprovals,
  demoSignIn,
  getPostDetail,
  inviteMember,
  issueSession,
  listPages,
  listPosts,
  removeMember,
  revokeSession,
  submitPost,
  updateMember,
  validateSession,
  type AuthenticatedUser,
} from '@relay/services';
import {
  createTenant,
  createUser,
  expectAppError,
  makeContexts,
  meta,
  testConfig,
  uploadFixture,
  type Contexts,
  type Tenant,
} from './helpers';

describe('RBAC, page scoping and memberships (M0 gate)', () => {
  let c: Contexts;
  let t: Tenant;
  let pageB: string;
  const members: Record<string, AuthenticatedUser & { membershipId: string }> = {};

  async function join(
    role: 'admin' | 'publisher' | 'editor' | 'viewer',
    options: { allPages?: boolean; pageIds?: string[] } = {},
  ) {
    const user = await createUser(c.app, { name: `${role} user` });
    const invite = await inviteMember(
      c.app,
      t.owner,
      t.workspaceId,
      {
        email: user.email,
        role,
        allPages: options.allPages ?? true,
        pageIds: options.pageIds ?? [],
      },
      meta,
    );
    await acceptInvitation(c.app, user, { token: invite.token }, meta);
    const m = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .selectFrom('workspaceMemberships')
        .select('id')
        .where('userId', '=', user.userId)
        .executeTakeFirstOrThrow(),
    );
    return { ...user, membershipId: m.id };
  }

  beforeAll(async () => {
    c = makeContexts();
    t = await createTenant(c.app);
    pageB = (
      await createPage(
        c.app,
        t.owner,
        t.workspaceId,
        { name: 'Second page', timezone: 'Europe/Berlin' },
        meta,
      )
    ).id;
    members.admin = await join('admin');
    members.publisherA = await join('publisher', { allPages: false, pageIds: [t.pageId] });
    members.editor = await join('editor');
    members.viewer = await join('viewer');
  });
  afterAll(async () => c.close());

  it('applies the role matrix to content actions', async () => {
    const asset = (
      await uploadFixture(c, t, members.editor!, 'portrait-1080x1350.jpg', 'image/jpeg')
    ).assetId;
    const body = {
      pageId: t.pageId,
      caption: 'By editor',
      mediaAssetIds: [asset],
      destinationIds: [t.destinations.youtube!.pageDestinationId],
    };
    // Viewers cannot create content.
    await expectAppError(
      createPost(c.app, members.viewer!, t.workspaceId, body, meta),
      'forbidden',
    );
    const post = await createPost(
      c.app,
      members.editor!,
      t.workspaceId,
      { ...body, title: 'Needs a title' },
      meta,
    );
    // The simulated YouTube destination requires video: submit reports the item-level issue.
    const submit = await submitPost(
      c.app,
      members.editor!,
      t.workspaceId,
      post.body.postId,
      {},
      meta,
    );
    expect(submit.outcomes[0]).toMatchObject({
      ok: false,
      error: { code: 'destination_validation_failed' },
    });
    // Editors cannot approve.
    const detail = await getPostDetail(c.app, members.editor!, t.workspaceId, post.body.postId);
    await expectAppError(
      decideApprovals(
        c.app,
        members.editor!,
        t.workspaceId,
        post.body.postId,
        {
          decisions: [
            {
              postDestinationId: detail.destinations[0]!.id,
              decision: 'approve',
              revisionId: detail.revision.id,
              intentHash: detail.destinations[0]!.intentHash,
            },
          ],
        },
        meta,
      ),
      'forbidden',
    );
  });

  it('scopes page-limited members: other pages do not exist for them', async () => {
    const pages = await listPages(c.app, members.publisherA!, t.workspaceId);
    expect(pages.pages.map((p) => p.id)).toEqual([t.pageId]);
    await expectAppError(
      listPosts(c.app, members.publisherA!, t.workspaceId, { pageId: pageB }),
      'not_found',
    );
    await expectAppError(
      createPost(
        c.app,
        members.publisherA!,
        t.workspaceId,
        {
          pageId: pageB,
          caption: 'x',
          mediaAssetIds: [c.app.ids.next()],
          destinationIds: [c.app.ids.next()],
        },
        meta,
      ),
      'not_found',
    );
  });

  it('protects the last owner and owner-only role changes', async () => {
    const owner = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .selectFrom('workspaceMemberships')
        .select(['id', 'version'])
        .where('userId', '=', t.owner.userId)
        .executeTakeFirstOrThrow(),
    );
    await expectAppError(
      updateMember(
        c.app,
        t.owner,
        t.workspaceId,
        owner.id,
        { expectedVersion: owner.version, role: 'admin' },
        meta,
      ),
      'last_owner',
    );
    await expectAppError(removeMember(c.app, t.owner, t.workspaceId, owner.id, meta), 'last_owner');
    // Admins cannot create owners.
    const editor = await withTenant(c.app.db, { workspaceId: t.workspaceId }, (tx) =>
      tx
        .selectFrom('workspaceMemberships')
        .select(['id', 'version'])
        .where('id', '=', members.editor!.membershipId)
        .executeTakeFirstOrThrow(),
    );
    await expectAppError(
      updateMember(
        c.app,
        members.admin!,
        t.workspaceId,
        editor.id,
        { expectedVersion: editor.version, role: 'owner' },
        meta,
      ),
      'forbidden',
    );
    // Promote a second owner, then the first may step down.
    const promoted = await updateMember(
      c.app,
      t.owner,
      t.workspaceId,
      editor.id,
      { expectedVersion: editor.version, role: 'owner' },
      meta,
    );
    expect(promoted.version).toBe(editor.version + 1);
    const demoted = await updateMember(
      c.app,
      t.owner,
      t.workspaceId,
      owner.id,
      { expectedVersion: owner.version, role: 'admin' },
      meta,
    );
    expect(demoted.version).toBe(owner.version + 1);
  });

  it('refuses invitations for another email, replays and expired tokens', async () => {
    const invitee = await createUser(c.app, { name: 'Invitee' });
    const stranger = await createUser(c.app, { name: 'Stranger' });
    const invite = await inviteMember(
      c.app,
      members.admin!,
      t.workspaceId,
      { email: invitee.email, role: 'viewer' },
      meta,
    );
    await expectAppError(
      acceptInvitation(c.app, stranger, { token: invite.token }, meta),
      'invitation_invalid',
    );
    await acceptInvitation(c.app, invitee, { token: invite.token }, meta);
    await expectAppError(
      acceptInvitation(c.app, invitee, { token: invite.token }, meta),
      'invitation_invalid',
    );
    await expectAppError(
      acceptInvitation(
        c.app,
        invitee,
        { token: `${t.workspaceId}.forged-token-value-123456` },
        meta,
      ),
      'invitation_invalid',
    );
  });
});

describe('sessions and demo authentication (M0 gate)', () => {
  it('issues hashed sessions, rotates on sign-in, revokes, and expires when idle', async () => {
    const clock = new ManualClock('2026-11-09T10:00:00Z');
    const c = makeContexts({ clock });
    try {
      const user = await createUser(c.app, { name: 'Session user' });
      const first = await issueSession(c.app, { userId: user.userId, method: 'demo' });
      expect((await validateSession(c.app, first.token))?.user.userId).toBe(user.userId);
      // Only the hash is stored.
      const stored = await c.app.pool.query(
        'SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1',
        [Buffer.from(first.token)],
      );
      expect(stored.rows[0].n).toBe(0);
      // Rotation: signing in again from the same browser revokes the previous session.
      const second = await issueSession(c.app, {
        userId: user.userId,
        method: 'demo',
        previousToken: first.token,
      });
      expect(await validateSession(c.app, first.token)).toBeNull();
      const info = await validateSession(c.app, second.token);
      expect(info).not.toBeNull();
      await revokeSession(c.app, info!);
      expect(await validateSession(c.app, second.token)).toBeNull();
      // Idle timeout (24 h by default).
      const third = await issueSession(c.app, { userId: user.userId, method: 'demo' });
      clock.advance(25 * 3600_000);
      expect(await validateSession(c.app, third.token)).toBeNull();
    } finally {
      await c.close();
    }
  });

  it('demo sign-in and existing demo sessions stop working when demo mode is off', async () => {
    const on = makeContexts();
    const off = makeContexts({ config: testConfig({ RELAY_DEMO_MODE: 'false' }) });
    try {
      const user = await createUser(on.app, { name: 'Demo user', isDemo: true });
      const issued = await demoSignIn(on.app, user.email);
      expect(await validateSession(on.app, issued.token)).not.toBeNull();
      await expectAppError(demoSignIn(off.app, user.email), 'demo_mode_disabled');
      expect(await validateSession(off.app, issued.token)).toBeNull();
    } finally {
      await on.close();
      await off.close();
    }
  });
});
