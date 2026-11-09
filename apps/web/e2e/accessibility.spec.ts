import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('keyboard and theme', () => {
  test('dialogs trap focus, close on Escape and restore focus to the opener', async ({ page }) => {
    await signIn(page, 'Mara Lindqvist');
    await page.goto('/w/fernhill/calendar');
    const move = page.getByRole('button', { name: /^Move / }).first();
    await move.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Move post' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('You are about to publish to')).toBeVisible();
    // Focus is inside the dialog.
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(move).toBeFocused();
  });

  test('the skip link and navigation are keyboard reachable', async ({ page }) => {
    await signIn(page, 'Mara Lindqvist');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
  });

  test('the dark theme applies to the same workflow screens', async ({ page, context }) => {
    await signIn(page, 'Mara Lindqvist');
    await context.addCookies([{ name: 'relay_theme', value: 'dark', url: 'http://localhost:3100' }]);
    for (const path of ['/w/fernhill/calendar', '/w/fernhill/posts', '/w/fernhill/results']) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe('rgb(20, 20, 20)'); // Ink
    }
  });
});
