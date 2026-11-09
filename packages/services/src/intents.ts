import type { Tx } from '@relay/db';
import {
  DEFAULT_DECLARATIONS,
  formatOf,
  normalizeText,
  validateForDestination,
  type ContentFormat,
  type CreatorDeclarations,
  type DestinationIssue,
  type DestinationProviderId,
  type PublishIntentPayload,
  type Visibility,
} from '@relay/domain';
import { intentHash } from '@relay/domain/server';
import type { IntentMediaItem } from '@relay/providers';
import {
  adapterCapabilities,
  evaluateCapabilities,
  toConnectedAccount,
  type AccountRow,
} from './connections';
import type { ServiceContext } from './context';
import { evaluateRights, RIGHTS_PROBLEM_LABELS, type RightsDecision } from './rights';

/**
 * Building the normalised publish intent for one destination. Approval, scheduling and the
 * worker's pre-dispatch check all call `buildDestinationIntent` and compare hashes, so the
 * thing that was approved is provably the thing that gets published.
 */

export interface IntentIssue extends DestinationIssue {
  /** "submit" issues block review; "schedule" issues only block automatic publishing. */
  blocks: 'submit' | 'schedule';
  fallback?: 'manual_export' | 'reconnect' | null;
}

export interface RevisionBundle {
  revision: {
    id: string;
    postId: string;
    revisionNumber: number;
    title: string | null;
    caption: string;
    declarations: CreatorDeclarations;
  };
  media: Array<IntentMediaItem & { status: string; pageId: string; rightsVersion: number }>;
  variants: Map<
    string,
    {
      caption: string;
      title: string | null;
      visibility: Visibility;
      metadata: Record<string, string | number | boolean | null>;
    }
  >;
}

export interface DestinationTarget {
  postDestinationId: string;
  pageDestinationId: string;
  pageId: string;
  pageAllowedFormats: string[];
  account: AccountRow;
  grantedScopes: string[];
}

export interface BuiltIntent {
  payload: PublishIntentPayload;
  hash: string;
  format: ContentFormat | 'none';
  issues: IntentIssue[];
  rights: RightsDecision;
  mediaReady: boolean;
}

export async function loadRevisionBundle(tx: Tx, revisionId: string): Promise<RevisionBundle> {
  const revision = await tx
    .selectFrom('postRevisions')
    .select(['id', 'postId', 'revisionNumber', 'title', 'caption', 'declarations'])
    .where('id', '=', revisionId)
    .executeTakeFirstOrThrow();
  const media = await tx
    .selectFrom('postRevisionMedia as rm')
    .innerJoin('mediaAssets as a', 'a.id', 'rm.assetId')
    .select([
      'rm.position',
      'rm.assetId',
      'rm.assetVersion',
      'a.kind',
      'a.declaredMime',
      'a.sizeBytes',
      'a.width',
      'a.height',
      'a.durationMs',
      'a.sha256',
      'a.status',
      'a.pageId',
      'a.rightsVersion',
    ])
    .where('rm.revisionId', '=', revisionId)
    .orderBy('rm.position')
    .execute();
  const variants = await tx
    .selectFrom('postRevisionVariants')
    .select(['postDestinationId', 'caption', 'title', 'visibility', 'metadata'])
    .where('revisionId', '=', revisionId)
    .execute();
  return {
    revision: {
      ...revision,
      declarations: {
        ...DEFAULT_DECLARATIONS,
        ...(revision.declarations as Partial<CreatorDeclarations>),
      },
    },
    media: media.map((m) => ({
      position: m.position,
      assetId: m.assetId,
      assetVersion: m.assetVersion,
      kind: m.kind as 'video' | 'image',
      mime: m.declaredMime,
      sizeBytes: m.sizeBytes,
      width: m.width ?? 0,
      height: m.height ?? 0,
      durationMs: m.durationMs,
      sha256: m.sha256 ?? '',
      status: m.status,
      pageId: m.pageId,
      rightsVersion: m.rightsVersion,
    })),
    variants: new Map(
      variants.map((v) => [
        v.postDestinationId,
        {
          caption: v.caption,
          title: v.title,
          visibility: v.visibility as Visibility,
          metadata: (v.metadata ?? {}) as Record<string, string | number | boolean | null>,
        },
      ]),
    ),
  };
}

export async function loadDestinationTargets(tx: Tx, postId: string): Promise<DestinationTarget[]> {
  const rows = await tx
    .selectFrom('postDestinations as pd')
    .innerJoin('pageDestinations as d', 'd.id', 'pd.pageDestinationId')
    .innerJoin('pages as p', 'p.id', 'd.pageId')
    .innerJoin('socialAccounts as a', 'a.id', 'd.socialAccountId')
    .innerJoin('providerGrants as g', 'g.id', 'a.grantId')
    .select([
      'pd.id as postDestinationId',
      'd.id as pageDestinationId',
      'p.id as pageId',
      'p.allowedFormats',
      'a.id',
      'a.workspaceId',
      'a.grantId',
      'a.provider',
      'a.connectionMode',
      'a.providerAccountId',
      'a.displayName',
      'a.handle',
      'a.accountType',
      'a.simulatorProfile',
      'a.status',
      'a.healthReason',
      'a.connectionGeneration',
      'g.grantedScopes',
    ])
    .where('pd.postId', '=', postId)
    .orderBy('d.label')
    .execute();
  return rows.map((r) => ({
    postDestinationId: r.postDestinationId,
    pageDestinationId: r.pageDestinationId,
    pageId: r.pageId,
    pageAllowedFormats: r.allowedFormats,
    grantedScopes: r.grantedScopes,
    account: {
      id: r.id,
      workspaceId: r.workspaceId,
      grantId: r.grantId,
      provider: r.provider,
      connectionMode: r.connectionMode,
      providerAccountId: r.providerAccountId,
      displayName: r.displayName,
      handle: r.handle,
      accountType: r.accountType,
      simulatorProfile: r.simulatorProfile,
      status: r.status,
      healthReason: r.healthReason,
      connectionGeneration: r.connectionGeneration,
    },
  }));
}

const CAPABILITY_FOR_FORMAT = {
  video: 'publish.video',
  image: 'publish.image',
  carousel: 'publish.carousel',
} as const;

export async function buildDestinationIntent(
  tx: Tx,
  ctx: ServiceContext,
  input: { workspaceId: string; bundle: RevisionBundle; target: DestinationTarget; at: Date },
): Promise<BuiltIntent> {
  const { bundle, target } = input;
  const variant = bundle.variants.get(target.postDestinationId);
  const caption = normalizeText(variant?.caption ?? bundle.revision.caption);
  const title = variant?.title ?? bundle.revision.title;
  const visibility = variant?.visibility ?? 'public';
  const provider = target.account.provider as DestinationProviderId;
  const issues: IntentIssue[] = [];

  const mediaReady = bundle.media.length > 0 && bundle.media.every((m) => m.status === 'ready');
  for (const m of bundle.media) {
    if (m.status === 'validating' || m.status === 'uploading') {
      issues.push({
        field: 'media',
        code: 'media_processing',
        message: 'Media is still being validated.',
        blocks: 'submit',
      });
    } else if (m.status !== 'ready') {
      issues.push({
        field: 'media',
        code: 'media_unavailable',
        message: 'Some media was rejected or deleted. Replace it.',
        blocks: 'submit',
      });
    }
  }
  const format = formatOf(
    bundle.media.map((m) => ({
      kind: m.kind,
      mime: m.mime,
      sizeBytes: m.sizeBytes,
      width: m.width,
      height: m.height,
      durationMs: m.durationMs,
    })),
  );
  if (format !== 'none' && !target.pageAllowedFormats.includes(format)) {
    issues.push({
      field: 'media',
      code: 'format_not_allowed',
      message: `This page does not allow ${format} posts.`,
      blocks: 'submit',
    });
  }

  const account = toConnectedAccount(target.account, target.grantedScopes);
  const caps = await adapterCapabilities(ctx, account);
  if (caps && mediaReady) {
    for (const issue of validateForDestination(caps.profile, {
      media: bundle.media,
      caption,
      title,
      visibility,
    })) {
      issues.push({ ...issue, blocks: 'submit' });
    }
  }
  if (format !== 'none') {
    const capability = evaluateCapabilities(ctx, account, caps)[CAPABILITY_FOR_FORMAT[format]];
    if (capability.state !== 'enabled') {
      issues.push({
        field: 'destination',
        code: capability.reasonCode ?? 'capability_unavailable',
        message: capability.message,
        blocks: 'schedule',
        fallback: capability.fallback,
      });
    }
  }

  const rights = await evaluateRights(tx, {
    assetIds: bundle.media.map((m) => m.assetId),
    provider,
    operation: 'publish',
    at: input.at,
  });
  for (const problem of rights.problems) {
    issues.push({
      field: 'media',
      code: 'rights_missing',
      message: RIGHTS_PROBLEM_LABELS[problem.reason],
      blocks: 'submit',
    });
  }

  const payload: PublishIntentPayload = {
    workspaceId: input.workspaceId,
    postId: bundle.revision.postId,
    destination: {
      pageDestinationId: target.pageDestinationId,
      socialAccountId: target.account.id,
      provider,
      connectionMode: target.account.connectionMode as 'simulated' | 'live',
      providerAccountId: target.account.providerAccountId,
    },
    media: bundle.media.map((m) => ({
      position: m.position,
      assetId: m.assetId,
      assetVersion: m.assetVersion,
      kind: m.kind,
      sha256: m.sha256 || null,
    })),
    caption,
    title: title ?? null,
    visibility,
    metadata: variant?.metadata ?? {},
    declarations: bundle.revision.declarations,
    rights: rights.grants,
  };
  return { payload, hash: intentHash(payload), format, issues, rights, mediaReady };
}
