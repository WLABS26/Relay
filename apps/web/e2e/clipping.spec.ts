import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURES } from './env';
import { signIn, signOut, workspaceId } from './helpers';

interface Candidate {
  id: string;
  rank: number;
  startMs: number;
  endMs: number;
}
interface ClipDetail {
  clip: {
    id: string;
    currentRevisionId: string;
    sourceAssetId: string;
    candidateId: string | null;
  };
  revision: { revisionNumber: number; startMs: number; endMs: number };
  latestRender: {
    revisionId: string;
    status: string;
    outputAssetId: string;
    outputAssetStatus: string | null;
  } | null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

async function csrfHeaders(page: Page, baseURL: string) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'relay_csrf')!.value;
  return { 'x-csrf-token': csrf, origin: new URL(baseURL).origin };
}

// The second test uses the clip the first one makes.
test.describe.configure({ mode: 'serial' });

test.describe('M2 gate: source video → suggestions → clip → render → draft post', () => {
  test('a marketer clips an uploaded video and hands the render over as a draft', async ({
    page,
  }) => {
    await signIn(page, 'Mara Lindqvist');
    const ws = await workspaceId(page, 'fernhill');
    const api = `/api/v1/workspaces/${ws}`;

    // Find clips lists the seeded videos; the fixture with authored highlights is uploaded so
    // the suggestions do not depend on what the seed happens to contain.
    await page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Find clips' })
      .click();
    await expect(page.getByRole('heading', { name: 'Find clips', level: 1 })).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Source videos' }).getByRole('listitem').first(),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Upload a video' }).first().click();
    await expect(page.getByRole('heading', { name: 'Upload a video to clip' })).toBeVisible();
    await page.getByLabel('Page', { exact: true }).selectOption({ label: 'Fernhill Coffee' });
    await page.setInputFiles('[data-testid="file-input"]', path.join(FIXTURES, 'highlight.mp4'));
    await page.getByRole('checkbox', { name: /I own this media/ }).check();
    await page.getByRole('button', { name: 'Upload and analyse' }).click();

    // Validation by the media worker, then the analysis job, followed on the video's screen.
    await page.waitForURL(new RegExp(`/w/fernhill/find-clips/${UUID}$`), { timeout: 150_000 });
    const assetId = new URL(page.url()).pathname.split('/').pop()!;
    await expect(page.getByRole('heading', { name: 'highlight.mp4', level: 1 })).toBeVisible();
    const candidates = page.locator('.candidate');
    await expect(candidates.first()).toBeVisible({ timeout: 150_000 });
    // Every suggestion says why it was picked and how sure the ranker is.
    await expect(candidates.first().getByText(/Score \d+ out of 100/)).toBeVisible();
    await expect(candidates.first().getByText(/(High|Medium|Low) confidence/)).toBeVisible();

    const listed = (await (
      await page.request.get(`${api}/assets/${assetId}/candidates`)
    ).json()) as {
      analysis: { status: string };
      candidates: Candidate[];
    };
    expect(listed.analysis.status).toBe('succeeded');
    const top = listed.candidates[0]!;
    expect(top.rank).toBe(1);
    // The authored loud burst of the fixture runs from 40 s to 46 s.
    expect(top.startMs).toBeLessThan(46_000);
    expect(top.endMs).toBeGreaterThan(40_000);

    // A clip from the top suggestion opens in the editor with the suggested range.
    await page.getByRole('button', { name: 'Edit suggestion 1 as a clip' }).click();
    await page.waitForURL(new RegExp(`/w/fernhill/clips/${UUID}$`));
    const clipId = new URL(page.url()).pathname.split('/').pop()!;
    await expect(page.getByRole('slider', { name: 'Clip end' })).toHaveAttribute(
      'aria-valuenow',
      String(top.endMs / 1000),
    );

    // Move the end with the typed field (no dragging): one second shorter.
    const newEndMs = Math.round((top.endMs - 1000) / 100) * 100;
    expect(newEndMs - top.startMs).toBeGreaterThanOrEqual(1000);
    const end = page.getByRole('textbox', { name: 'End', exact: true });
    await end.fill((newEndMs / 1000).toFixed(1));
    await end.press('Enter');
    await expect(page.getByRole('slider', { name: 'Clip end' })).toHaveAttribute(
      'aria-valuenow',
      String(newEndMs / 1000),
    );
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    // Save and render: a new revision, then the render job on the worker.
    await page.getByRole('button', { name: 'Save and render' }).click();
    await expect(page.getByText('Saved as revision 2')).toBeVisible();
    const createDraft = page.getByRole('button', { name: 'Create draft post' });
    await expect(createDraft).toBeVisible({ timeout: 150_000 });
    await expect(page.locator('.r-badge', { hasText: 'Rendered' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download MP4' })).toBeVisible();

    const detail = (await (await page.request.get(`${api}/clips/${clipId}`)).json()) as ClipDetail;
    expect(detail.revision).toMatchObject({ revisionNumber: 2, endMs: newEndMs });
    expect(detail.latestRender).toMatchObject({
      revisionId: detail.clip.currentRevisionId,
      status: 'succeeded',
      outputAssetStatus: 'ready',
    });
    const outputAssetId = detail.latestRender!.outputAssetId;
    expect(outputAssetId).not.toBe(assetId);

    // Hand-off: a draft post that carries the rendered clip, not the source video.
    await createDraft.click();
    await page.waitForURL(new RegExp(`/w/fernhill/posts/${UUID}$`));
    const postId = new URL(page.url()).pathname.split('/').pop()!;
    const media = page.getByRole('list', { name: 'Media in order' }).getByRole('listitem');
    await expect(media).toHaveCount(1);
    await expect(media.first()).toContainText('1. video');
    await expect(media.first().getByRole('img', { name: 'Media 1 preview' })).toBeVisible();
    const post = (await (await page.request.get(`${api}/posts/${postId}`)).json()) as {
      media: Array<{ assetId: string; status: string; durationMs: number | null }>;
      destinations: Array<{ state: string }>;
    };
    expect(post.media.map((m) => m.assetId)).toEqual([outputAssetId]);
    expect(post.media[0]!.status).toBe('ready');
    // The rendered clip is as long as the edited range (within a frame or two).
    expect(Math.abs(post.media[0]!.durationMs! - (newEndMs - top.startMs))).toBeLessThan(250);
    // Nothing was published or scheduled by the hand-off.
    expect(post.destinations.length).toBeGreaterThan(0);
    for (const d of post.destinations) expect(d.state).toBe('draft');
  });

  test('clip routes are tenant-bound, need CSRF on mutations and respect the role', async ({
    page,
    baseURL,
  }) => {
    await signIn(page, 'Mara Lindqvist');
    const fernhill = await workspaceId(page, 'fernhill');
    const own = `/api/v1/workspaces/${fernhill}`;
    const { clips } = (await (await page.request.get(`${own}/clips`)).json()) as {
      clips: Array<{ id: string; sourceAssetId: string; candidateId: string | null }>;
    };
    const clip = clips.find((c) => c.candidateId !== null)!;
    expect(clip, 'the clip made from a suggestion in the first test').toBeTruthy();
    const edit = {
      version: 1,
      startMs: 0,
      endMs: 2000,
      aspect: '9:16',
      cropMode: 'fill',
      captions: null,
    };
    const mutations: Array<{ method: 'post' | 'patch'; path: string; data?: unknown }> = [
      { method: 'post', path: `/assets/${clip.sourceAssetId}/analyses`, data: {} },
      {
        method: 'post',
        path: `/candidates/${clip.candidateId}/feedback`,
        data: { feedback: 'wrong_fit' },
      },
      {
        method: 'post',
        path: '/clips',
        data: { sourceAssetId: clip.sourceAssetId, startMs: 0, endMs: 2000 },
      },
      { method: 'patch', path: `/clips/${clip.id}`, data: edit },
      {
        method: 'post',
        path: `/clips/${clip.id}/captions/import`,
        data: { format: 'srt', text: '1\n00:00:00,000 --> 00:00:01,000\nHello\n' },
      },
      { method: 'post', path: `/clips/${clip.id}/renders`, data: {} },
      { method: 'post', path: `/clips/${clip.id}/exports` },
      { method: 'post', path: `/clips/${clip.id}/posts`, data: {} },
    ];

    // Same origin but no CSRF token: every mutation is refused before it reaches a service.
    const origin = new URL(baseURL!).origin;
    for (const m of mutations) {
      const r = await page.request[m.method](`${own}${m.path}`, {
        headers: { origin },
        ...(m.data === undefined ? {} : { data: m.data }),
      });
      expect(r.status(), `no CSRF: ${m.path}`).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe('csrf_failed');
    }
    // IDs that are not UUIDs do not reach the database.
    for (const url of [`${own}/clips/not-a-uuid`, `${own}/assets/1%27--/candidates`]) {
      expect((await page.request.get(url)).status(), url).toBe(404);
    }
    const before = (await (await page.request.get(`${own}/clips/${clip.id}`)).json()) as ClipDetail;
    await signOut(page);

    // Another tenant: the clip, its source and its suggestion do not exist, in either
    // workspace's URL space, for reads and for mutations alike.
    await signIn(page, 'Gus Ferreira');
    const kestrel = await workspaceId(page, 'kestrel');
    const gus = await csrfHeaders(page, baseURL!);
    for (const base of [`/api/v1/workspaces/${kestrel}`, own]) {
      for (const url of [
        `${base}/clips/${clip.id}`,
        `${base}/assets/${clip.sourceAssetId}/candidates`,
        `${base}/assets/${clip.sourceAssetId}/url?variant=proxy`,
      ]) {
        const r = await page.request.get(url);
        expect(r.status(), url).toBe(404);
        expect(((await r.json()) as { code: string }).code).toBe('not_found');
      }
      for (const m of mutations) {
        const r = await page.request[m.method](`${base}${m.path}`, {
          headers: gus,
          ...(m.data === undefined ? {} : { data: m.data }),
        });
        expect(r.status(), `cross-tenant: ${base}${m.path}`).toBe(404);
      }
    }
    const listed = (await (
      await page.request.get(
        `/api/v1/workspaces/${kestrel}/clips?sourceAssetId=${clip.sourceAssetId}`,
      )
    ).json()) as { clips: unknown[] };
    expect(listed.clips).toEqual([]);
    await signOut(page);

    // A viewer of the same workspace can open the clip but cannot change, render or post it.
    await signIn(page, 'Vic Osei');
    const vic = await csrfHeaders(page, baseURL!);
    expect((await page.request.get(`${own}/clips/${clip.id}`)).status()).toBe(200);
    for (const m of mutations.filter((x) => !x.path.endsWith('/exports'))) {
      const r = await page.request[m.method](`${own}${m.path}`, {
        headers: vic,
        ...(m.data === undefined ? {} : { data: m.data }),
      });
      expect(r.status(), `viewer: ${m.path}`).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe('forbidden');
    }
    await page.goto(`/w/fernhill/clips/${clip.id}`);
    await expect(page.getByText('You can view this clip')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save clip' })).toHaveCount(0);
    await expect(page.getByRole('slider', { name: 'Clip end' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await signOut(page);

    // None of the refused requests changed the clip.
    await signIn(page, 'Mara Lindqvist');
    const after = (await (await page.request.get(`${own}/clips/${clip.id}`)).json()) as ClipDetail;
    expect(after.clip.currentRevisionId).toBe(before.clip.currentRevisionId);
    expect(after.revision).toEqual(before.revision);
  });
});
