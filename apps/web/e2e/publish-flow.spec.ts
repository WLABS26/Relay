import path from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURES } from './env';
import { signIn } from './helpers';

test.describe('M1 gate: upload → approval → schedule → worker → confirmed simulated post', () => {
  test('a marketer publishes an uploaded video through the simulator', async ({ page }) => {
    await signIn(page, 'Mara Lindqvist');

    // Upload: real presigned PUT to object storage, then validation by the media worker.
    await page.goto('/w/fernhill/upload');
    await page.getByLabel('Page', { exact: true }).selectOption({ label: 'Fernhill Coffee' });
    await page.setInputFiles(
      '[data-testid="file-input"]',
      path.join(FIXTURES, 'vertical-1080x1920-8s.mp4'),
    );
    await page.getByRole('checkbox', { name: /I own this media/ }).check();
    await page.getByRole('button', { name: /Upload 1 file/ }).click();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('1080×1920 · 8 s')).toBeVisible();

    // Draft with two destinations.
    await page.getByLabel('Title').fill('E2E · Cold brew ratio');
    await page.getByLabel(/^Caption/).fill('E2E caption: 1:8 ratio, 16 hours.');
    await page.getByRole('checkbox', { name: /TikTok/ }).uncheck();
    await page.getByRole('checkbox', { name: /Facebook Page/ }).uncheck();
    await page.getByRole('button', { name: 'Create draft' }).click();
    await page.waitForURL(/\/w\/fernhill\/posts\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'E2E · Cold brew ratio' })).toBeVisible();

    // Review: submit, then approve the exact version.
    await page.getByRole('button', { name: 'Submit for review' }).click();
    const yt = page.getByRole('article', { name: /YouTube · Fernhill Coffee/ });
    const ig = page.getByRole('article', { name: /Instagram · fernhill\.coffee/ });
    await expect(yt.locator('.r-badge', { hasText: 'Needs review' })).toBeVisible();
    await page.getByRole('button', { name: /Approve all/ }).click();
    await expect(yt.locator('.r-badge', { hasText: 'Approved' })).toBeVisible();
    await expect(ig.locator('.r-badge', { hasText: 'Approved' })).toBeVisible();

    // Schedule: the confirmation shows recipient account, visibility and local time zone.
    await yt.getByRole('button', { name: 'Schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule post' });
    await expect(dialog.getByText(/Europe\/Berlin/).first()).toBeVisible();
    await expect(dialog.getByText('Suggested ·', { exact: false }).first()).toBeVisible();
    await dialog.getByRole('radio', { name: /As soon as possible/ }).check();
    await expect(dialog.getByText('You are about to publish to')).toBeVisible();
    await expect(dialog.getByText(/Fernhill Coffee · YouTube/)).toBeVisible();
    await expect(dialog.locator('dd', { hasText: 'Public' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Publish as soon as possible' }).click();
    await expect(dialog).toBeHidden();

    // The worker prepares, waits for the planned time, dispatches and confirms.
    await expect(yt.locator('.r-badge', { hasText: 'Published' })).toBeVisible({
      timeout: 120_000,
    });
    await expect(yt.getByText(/sim_youtube_[0-9a-f]{12}/)).toBeVisible();
    await expect(yt.getByText(/simulated — not a real post/)).toBeVisible();
    await expect(page.getByText('Published (confirmed by platform)')).toBeVisible();
    await expect(page.getByText('Claimed for publishing')).toBeVisible();
    // Instagram stays approved and unscheduled: one destination never drags another along.
    await expect(ig.locator('.r-badge', { hasText: 'Approved' })).toBeVisible();

    // It shows in the calendar as published and in Results as simulated data.
    await page.goto('/w/fernhill/calendar');
    await expect(
      page.getByTestId('calendar-item').filter({ hasText: 'E2E · Cold brew ratio' }).first(),
    ).toContainText('Published');
    await page.goto('/w/fernhill/results');
    await expect(page.getByRole('link', { name: 'E2E · Cold brew ratio' })).toBeVisible();
    await expect(page.getByText('Simulated data')).toBeVisible();
  });

  test('a suggested slot is never shown as scheduled until it is booked', async ({ page }) => {
    await signIn(page, 'Mara Lindqvist');
    await page.goto('/w/fernhill/posts?state=needs_review');
    await page.getByRole('link', { name: 'Sample · Milk steaming tips' }).click();
    const yt = page.getByRole('article', { name: /YouTube · Fernhill Coffee/ });
    await yt.getByRole('button', { name: 'Approve this version' }).click();
    await expect(yt.locator('.r-badge', { hasText: 'Approved' })).toBeVisible();
    await yt.getByRole('button', { name: 'Schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule post' });
    await expect(
      dialog.getByText('Suggestions are not reserved until you schedule.', { exact: false }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(yt.locator('.r-badge', { hasText: 'Approved' })).toBeVisible(); // still not scheduled
  });
});
