import { expect, test } from '@playwright/test';
import { signIn, signOut } from './helpers';

/**
 * Membership changes through the UI. Uses demo users no other spec relies on (Kim, Theo),
 * because seeded data persists across specs within one run.
 */
test.describe('memberships', () => {
  test('a member of another workspace accepts an invitation and lands in it', async ({ page }) => {
    await signIn(page, 'Mara Lindqvist');
    await page.goto('/w/fernhill/settings/members');
    await page.getByLabel('Email', { exact: true }).fill('kim@kestrel.example');
    await page.getByLabel('Role', { exact: true }).selectOption('viewer');
    await page.getByRole('button', { name: 'Create invitation' }).click();
    const link = (await page.locator('code', { hasText: '/invite/' }).textContent())!.trim();
    await signOut(page);

    await signIn(page, 'Kim Sato');
    await page.goto(link.slice(link.indexOf('/invite/')));
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await page.waitForURL(/\/w\/fernhill\/inbox/);
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    const r = await page.request.get('/api/v1/workspaces');
    const memberships = (
      (await r.json()) as { workspaces: Array<{ slug: string; role: string }> }
    ).workspaces
      .map((w) => `${w.slug}:${w.role}`)
      .sort();
    expect(memberships).toEqual(['fernhill:viewer', 'kestrel:editor']);
  });

  test('leaving your only workspace is confirmed, then leads to creating a new one', async ({
    page,
  }) => {
    await signIn(page, 'Theo Brandt');
    await page.goto('/w/fernhill/settings/members');
    const leave = page
      .getByRole('row', { name: /Theo Brandt/ })
      .getByRole('button', { name: 'Leave' });

    // Dismissing the confirmation changes nothing.
    page.once('dialog', (d) => void d.dismiss());
    await leave.click();
    await expect(leave).toBeVisible();
    expect((await page.request.get('/w/fernhill/inbox')).status()).toBe(200);

    page.once('dialog', (d) => void d.accept());
    await leave.click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();
    expect((await page.request.get('/w/fernhill/inbox')).status()).toBe(404);

    await page.getByLabel('Workspace name').fill('Theo Labs');
    await page.getByLabel('Address').fill('theo-labs');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.waitForURL(/\/w\/theo-labs\/settings\/pages/);
  });
});
