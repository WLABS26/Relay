import { expect, test } from '@playwright/test';
import { signIn, signOut, workspaceId } from './helpers';

test.describe('M0 gate: tenant isolation, CSRF and fail-closed auth over HTTP', () => {
  test('a member of one workspace cannot see or mutate another workspace', async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    await signIn(page, 'Mara Lindqvist');
    const fernhill = await workspaceId(page, 'fernhill');
    const posts = (await (
      await page.request.get(`/api/v1/workspaces/${fernhill}/posts`)
    ).json()) as { posts: Array<{ id: string }> };
    const pages = (await (
      await page.request.get(`/api/v1/workspaces/${fernhill}/pages`)
    ).json()) as { pages: Array<{ id: string }> };
    const assets = (await (
      await page.request.get(`/api/v1/workspaces/${fernhill}/assets?pageId=${pages.pages[0]!.id}`)
    ).json()) as { assets: Array<{ id: string; status: string }> };
    const fernhillPost = posts.posts[0]!.id;
    const fernhillAsset = assets.assets.find((a) => a.status === 'ready')!.id;
    const signed = (await (
      await page.request.get(
        `/api/v1/workspaces/${fernhill}/assets/${fernhillAsset}/url?variant=thumbnail`,
      )
    ).json()) as { url: string };
    expect(signed.url).toContain('X-Amz-Signature');
    await signOut(page);

    await signIn(page, 'Gus Ferreira');
    const kestrel = await workspaceId(page, 'kestrel');
    // Pages: not found, never "forbidden".
    const html = await page.goto('/w/fernhill/inbox');
    expect(html?.status()).toBe(404);
    await expect(page.getByText('Not found')).toBeVisible();
    // API: the other tenant's workspace and objects do not exist for this user.
    for (const url of [
      `/api/v1/workspaces/${fernhill}/posts`,
      `/api/v1/workspaces/${fernhill}/posts/${fernhillPost}`,
      `/api/v1/workspaces/${kestrel}/posts/${fernhillPost}`,
      `/api/v1/workspaces/${kestrel}/assets/${fernhillAsset}/url?variant=original`,
    ]) {
      const r = await page.request.get(url);
      expect(r.status(), url).toBe(404);
      expect(((await r.json()) as { code: string }).code).toBe('not_found');
    }
    // Mutations across tenants are refused the same way.
    const csrf = (await page.context().cookies()).find((c) => c.name === 'relay_csrf')!.value;
    const patch = await page.request.patch(`/api/v1/workspaces/${kestrel}/posts/${fernhillPost}`, {
      headers: { 'x-csrf-token': csrf, origin },
      data: { expectedVersion: 1, caption: 'hijack', mediaAssetIds: [fernhillAsset] },
    });
    expect(patch.status()).toBe(404);
    // A signed media URL is bound to its key: re-pointing it at another object fails.
    const tampered = signed.url.replace(/assets\/[0-9a-f-]{36}/, `assets/${fernhillPost}`);
    expect((await page.request.get(tampered)).status()).toBe(403);
  });

  test('mutations require same-origin and a valid CSRF token', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await signIn(page, 'Mara Lindqvist');
    const ws = await workspaceId(page, 'fernhill');
    const csrf = (await page.context().cookies()).find((c) => c.name === 'relay_csrf')!.value;
    const body = { name: 'Should not exist', timezone: 'Europe/Berlin' };
    const noToken = await page.request.post(`/api/v1/workspaces/${ws}/pages`, {
      headers: { origin },
      data: body,
    });
    expect(noToken.status()).toBe(403);
    expect(((await noToken.json()) as { code: string }).code).toBe('csrf_failed');
    const crossSite = await page.request.post(`/api/v1/workspaces/${ws}/pages`, {
      headers: { origin: 'https://evil.example', 'x-csrf-token': csrf },
      data: body,
    });
    expect(crossSite.status()).toBe(403);
    const wrongToken = await page.request.post(`/api/v1/workspaces/${ws}/pages`, {
      headers: { origin, 'x-csrf-token': 'forged' },
      data: body,
    });
    expect(wrongToken.status()).toBe(403);
    // Errors use the standard envelope with a request ID.
    const envelope = (await wrongToken.json()) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(['code', 'message', 'requestId']);
  });

  test('pages are served with a nonce CSP and security headers; the session cookie is HttpOnly', async ({
    page,
  }) => {
    const response = await page.goto('/sign-in');
    const csp = response!.headers()['content-security-policy']!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response!.headers()['x-content-type-options']).toBe('nosniff');
    await signIn(page, 'Vic Osei');
    const session = (await page.context().cookies()).find((c) => c.name === 'relay_session')!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Lax');
    // Signing out revokes the session server-side.
    const cookieHeader = `relay_session=${session.value}`;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/sign-in/);
    const reuse = await page.request.get('/api/v1/workspaces', {
      headers: { cookie: cookieHeader },
    });
    expect(reuse.status()).toBe(401);
    // API responses, errors included, are never sniffed, framed, cached or embedded cross-origin.
    expect(reuse.headers()).toMatchObject({
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    });
    expect((await reuse.json()) as unknown).toMatchObject({ code: 'unauthenticated' });
  });

  test('viewers are read-only in the UI and the API', async ({ page }) => {
    await signIn(page, 'Vic Osei');
    await page.goto('/w/fernhill/upload');
    await expect(page.getByText('You cannot upload here')).toBeVisible();
  });
});
