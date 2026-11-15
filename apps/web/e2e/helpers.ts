import { expect, type Page } from '@playwright/test';

export async function signIn(page: Page, name: string) {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.waitForURL(/\/w\/[a-z0-9-]+\/inbox/);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/);
}

/** Read a workspace ID through the API as the signed-in user. */
export async function workspaceId(page: Page, slug: string): Promise<string> {
  const r = await page.request.get('/api/v1/workspaces');
  const body = (await r.json()) as { workspaces: Array<{ id: string; slug: string }> };
  const ws = body.workspaces.find((w) => w.slug === slug);
  if (!ws) throw new Error(`workspace ${slug} not visible`);
  return ws.id;
}

/**
 * Open the calendar on a week that has scheduled sample posts. The seed books the next free
 * slots, which late on the last day of a week all fall into the following week.
 */
export async function gotoCalendarWithPosts(page: Page, slug: string) {
  await page.goto(`/w/${slug}/calendar`);
  const move = page.getByRole('button', { name: /^Move / }).first();
  for (let week = 0; week < 2; week++) {
    try {
      await move.waitFor({ state: 'attached', timeout: 5_000 });
      return;
    } catch {
      await page.getByRole('link', { name: 'Next week' }).click();
    }
  }
  await move.waitFor({ state: 'attached', timeout: 15_000 });
}
