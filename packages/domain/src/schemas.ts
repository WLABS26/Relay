import { z } from 'zod';
import { CONTENT_FORMATS, DESTINATION_PROVIDERS, PAGE_GOALS, VISIBILITIES } from './providers';
import { ROLES } from './roles';
import { publishingRulesSchema } from './scheduling/rules';

/**
 * Request schemas shared by route handlers (server validation) and forms (client hints).
 * All objects are strict: unknown keys are rejected rather than silently ignored.
 */

export const uuid = z.uuid({ version: 'v7' }).or(z.uuid());
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3–40 lowercase letters, numbers or hyphens');
const timezone = z.string().trim().min(1).max(64);
const weekStart = z.enum(['monday', 'sunday']);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const tagList = z.array(z.string().trim().min(1).max(40)).max(20);

export const createWorkspaceSchema = z.strictObject({
  name: shortText(80),
  slug,
  timezone,
  weekStart: weekStart.default('monday'),
});

export const updateWorkspaceSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  name: shortText(80).optional(),
  timezone: timezone.optional(),
  weekStart: weekStart.optional(),
});

export const createPageSchema = z.strictObject({
  name: shortText(80),
  timezone,
  weekStart: weekStart.default('monday'),
  goal: z.enum(PAGE_GOALS).default('views'),
  topics: tagList.default([]),
  contentPillars: tagList.default([]),
  allowedFormats: z.array(z.enum(CONTENT_FORMATS)).min(1).default(['video', 'image', 'carousel']),
});

export const updatePageSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  name: shortText(80).optional(),
  timezone: timezone.optional(),
  weekStart: weekStart.optional(),
  goal: z.enum(PAGE_GOALS).optional(),
  topics: tagList.optional(),
  contentPillars: tagList.optional(),
  allowedFormats: z.array(z.enum(CONTENT_FORMATS)).min(1).optional(),
});

export const putPublishingRulesSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  rules: publishingRulesSchema,
});

export const pauseSchema = z.strictObject({
  reason: z.string().trim().max(280).optional(),
});

export const inviteMemberSchema = z.strictObject({
  email: z.email().max(254),
  role: z.enum(ROLES),
  allPages: z.boolean().default(true),
  pageIds: z.array(uuid).max(200).default([]),
});

export const updateMemberSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  role: z.enum(ROLES).optional(),
  allPages: z.boolean().optional(),
  pageIds: z.array(uuid).max(200).optional(),
});

export const acceptInvitationSchema = z.strictObject({
  token: z.string().min(20).max(200),
});

export const createDemoConnectionSchema = z.strictObject({
  provider: z.enum(DESTINATION_PROVIDERS),
  displayName: shortText(80),
  profile: z.enum([
    'reliable',
    'slow_processing',
    'rate_limited_once',
    'transient_then_ok',
    'lost_response',
    'ambiguous',
    'reject_format',
  ]).default('reliable'),
});

export const createDestinationSchema = z.strictObject({
  socialAccountId: uuid,
  label: shortText(80).optional(),
  defaultVisibility: z.enum(VISIBILITIES).default('public'),
});

// ----- Uploads ------------------------------------------------------------------------

export const rightsDeclarationSchema = z.strictObject({
  /** The uploader confirms they own the media or are authorised to publish it. */
  confirmed: z.literal(true, { error: 'Confirm that you own this media or are authorised to use it' }),
  statementVersion: z.string().min(1).max(40),
  /** Optional evidence pointer (contract ID, licence URL) — stored, never fetched. */
  evidence: z.string().trim().max(500).optional(),
  commercialUse: z.boolean().default(true),
});

export const createUploadSchema = z.strictObject({
  pageId: uuid.optional(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Optional base64 SHA-256 of the whole file (enforced by storage for single PUTs). */
  checksumSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
  declaration: rightsDeclarationSchema,
});

export const signPartsSchema = z.strictObject({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(50),
});

export const completeUploadSchema = z.strictObject({
  parts: z
    .array(z.strictObject({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .max(10_000)
    .optional(),
});

// ----- Posts --------------------------------------------------------------------------

export const declarationsSchema = z.strictObject({
  paidPartnership: z.boolean().default(false),
  alteredOrSyntheticMedia: z.boolean().default(false),
  madeForKids: z.boolean().nullable().default(null),
});

const metadataValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const destinationVariantSchema = z.strictObject({
  caption: z.string().max(5000).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  metadata: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), metadataValue).optional(),
});

export const postContentSchema = z.strictObject({
  title: z.string().trim().max(200).nullable().default(null),
  caption: z.string().max(5000).default(''),
  mediaAssetIds: z.array(uuid).min(1).max(20),
  declarations: declarationsSchema.default({ paidPartnership: false, alteredOrSyntheticMedia: false, madeForKids: null }),
  /** Per destination overrides keyed by page destination ID. */
  variants: z.record(uuid, destinationVariantSchema).default({}),
});

export const createPostSchema = postContentSchema.extend({
  pageId: uuid,
  campaignId: uuid.nullable().default(null),
  destinationIds: z.array(uuid).min(1).max(10),
});

export const updatePostSchema = postContentSchema.extend({
  expectedVersion: z.number().int().min(1),
});

export const submitPostSchema = z.strictObject({
  postDestinationIds: z.array(uuid).max(10).optional(),
});

export const approvalDecisionSchema = z.strictObject({
  postDestinationId: uuid,
  decision: z.enum(['approve', 'reject']),
  /** The revision and intent hash the reviewer looked at (optimistic check). */
  revisionId: uuid,
  intentHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().trim().max(1000).optional(),
  windowStartsAt: z.iso.datetime({ offset: true }).optional(),
  windowEndsAt: z.iso.datetime({ offset: true }).optional(),
});

export const approvalsSchema = z.strictObject({
  decisions: z.array(approvalDecisionSchema).min(1).max(10),
});

export const recommendSlotsSchema = z.strictObject({
  postDestinationIds: z.array(uuid).min(1).max(10),
  from: z.iso.datetime({ offset: true }).optional(),
  count: z.number().int().min(1).max(20).default(5),
  horizonDays: z.number().int().min(1).max(60).default(14),
});

export const scheduleSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    mode: z.enum(['at', 'asap']),
    /** Wall-clock time in the page zone, required for mode "at". */
    localTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
    /** Explicit offset for ambiguous (DST fall-back) times, e.g. "+01:00". */
    offset: z.string().regex(/^[+-]\d{2}:\d{2}$/).optional(),
    lockSlot: z.boolean().default(false),
  })
  .refine((v) => v.mode === 'asap' || Boolean(v.localTime), {
    message: 'Choose a local time',
    path: ['localTime'],
  });

export const versionedActionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});

export const lockSlotSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  locked: z.boolean(),
});

export const reconcileSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('link_external'),
    expectedVersion: z.number().int().min(1),
    externalId: z.string().trim().min(1).max(200),
    permalink: z.url({ protocol: /^https$/ }).optional(),
    reason: z.string().trim().min(3).max(1000),
  }),
  z.strictObject({
    action: z.literal('close_not_published'),
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().min(3).max(1000),
  }),
]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const calendarQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    pageId: uuid.optional(),
    destinationId: uuid.optional(),
    tz: timezone.optional(),
  })
  .refine((q) => q.from <= q.to, { message: '"from" must not be after "to"', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 62, {
    message: 'Calendar ranges are limited to 62 days',
    path: ['to'],
  });

export const resultsQuerySchema = z.object({
  pageId: uuid.optional(),
  provider: z.enum(DESTINATION_PROVIDERS).optional(),
  format: z.enum(CONTENT_FORMATS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const createCampaignSchema = z
  .strictObject({
    pageId: uuid.nullable().default(null),
    name: shortText(120),
    startsOn: isoDate.nullable().default(null),
    endsOn: isoDate.nullable().default(null),
  })
  .refine((c) => !c.startsOn || !c.endsOn || c.startsOn <= c.endsOn, {
    message: 'End date must be on or after the start date',
    path: ['endsOn'],
  });

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type CreateUploadInput = z.infer<typeof createUploadSchema>;
