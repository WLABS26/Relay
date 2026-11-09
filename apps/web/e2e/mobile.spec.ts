import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('the calendar switches to an agenda on small screens and keeps Move available', async ({
  page,
}) => {
  await signIn(page, 'Mara Lindqvist');
  await page.goto('/w/fernhill/calendar');
  await expect(page.getByRole('list', { name: 'Week view' })).toBeHidden();
  const agenda = page.getByRole('region', { name: 'Agenda' });
  await expect(agenda).toBeVisible();
  await expect(agenda.getByRole('button', { name: /^Move / }).first()).toBeVisible();
  // No horizontal page scroll at phone width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
