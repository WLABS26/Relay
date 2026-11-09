# Relay · Claude Code development prompt

**Product:** Relay, a publishing workspace for social media marketers and clippers  
**Design reference:** Relay Design System v1.1, Neutral Edition  
**Research baseline:** 9 November 2026. Recheck provider policies, scopes, endpoints, and limits at implementation and again before live enablement. Meta's published collections provide a starting point. Exact permissions and insights availability still need verification for the selected Graph version and app.

## How to use this prompt

Place this file at `docs/RELAY_BUILD_SPEC.md` in your repository. Unzip `Relay_Design_System.zip` to `design/relay/` so its guide, tokens, and `marks/` directory are available. Open Claude Code from the repository root and send the following.

> Read `docs/RELAY_BUILD_SPEC.md` in full. Inspect the repository and the Relay kit in `design/relay/`. Follow the execution contract below. Write the milestone plan, then implement and verify M0 and M1 in this session. Stop at their acceptance gates and report evidence, constraints, and the exact next milestone. Use the same spec and the updated implementation status for each subsequent milestone.

Everything below is the build prompt. If the kit is absent, use the specified color values and flag the missing vector assets. Keep the work moving.

---

## 1. Role and execution contract

Act as Relay's lead product engineer. Build a production-oriented, multi-tenant web app and background processing system. Deliver working, testable vertical slices. Start by inspecting existing source, `AGENTS.md`, `CLAUDE.md`, dependencies, Git status, auth, DB migrations, and deployment configuration. Preserve existing conventions and user changes where they meet the requirements. The stack below is the greenfield default. Record a short architectural decision for material deviations.

1. Create `docs/implementation-status.md` with milestone checklist, current branch, architecture decisions, provider capabilities, unresolved external approvals, and commands verified. Keep it current. Keep root `CLAUDE.md` short and point it at this spec and the status file.
2. Implement in milestone order. Each milestone must start from a clean local setup, include migrations and fixtures where relevant, and finish with actual checks. After an interruption, inspect Git diff and the status file before resuming. Do not re-scaffold completed work.
3. Use an entirely local demo with a deterministic provider simulator and synthetic media. Label demo connections and synthetic data everywhere. A simulator success demonstrates workflow behavior only. A provider integration is implemented only when the real adapter exists and is contract-tested. It is live-verified only after an authorized smoke test against a test account. Track these as separate states.
4. External side effects must be explicit. Work on local code, migrations, tests, and fixtures by default. Production deploys, migrations, billing, OAuth console changes, audit submissions, permission grants, and live posts require separate operator action. Use credentials provided by the operator in environment or secrets configuration. Keep placeholders in `.env.example`.
5. Report exact commands, checks and failures. Include test fixture IDs or sanitized staging IDs, behavior exercised, capability gaps, and the next runnable task. Never report fake connections or mocked publishing as live.
6. Keep the core free of an external model dependency. Use deterministic media analysis, manual controls, and inspectable statistics. Treat automatic sourcing, clipping, scheduling, and publishing as a policy-driven workflow with supervised progression. The public UI names the user action and evidence. Any model-backed captioning or analysis is a future, separately approved extension with a provider and data policy review.

## 2. Product and user flows

**Promise:** Upload finished content or turn an authorized stream into clips, fill a page's calendar, publish to connected accounts, and use results to improve future decisions.

- **Marketer:** Select a page, upload a video, image, or carousel, edit destination-specific copy and metadata, set campaign dates, review recommended slots, approve, and schedule. The app publishes in the background through supported APIs. The marketer can move or lock slots, override a recommendation, connect or reconnect accounts, and compare results.
- **Clipper:** Paste a supported stream, replay, or video URL. Resolve the source and show available metadata, signals, and media access separately. Review timestamped candidates with reasons and watch context. Attach an authorized recording where needed, set in and out points, reframe, edit captions, and render. Export if permitted, or hand a draft to the marketer without granting access to their social account.
- **Workspace operator:** Manage memberships and multiple pages. Give each page its own platform destinations, audience, content pillars, formats, brand presets, goal, time zone, quotas, and permission settings. Follow approved creator channels. Inspect a draft or post's lineage from source and edit through publish and measurement. Pause automation per page or workspace.
- **Independent discovery:** A public reference can support review, bookmarks, and a shareable timestamp brief for authorized workspace members. A pasted URL must never imply downloadable media, permission to repost, or access to historical live signals.
- **Outcomes:** Support goals such as views, qualified watch time, follower growth, conversions, and actual recorded revenue. Show unavailable metrics and attribution limits. Support tagged campaign links, actual revenue entries, and supported authorized revenue reporting. Do not promise virality, universal monetization, or payouts. Relay does not create social accounts or enroll creators in platform payout programs.

### Information architecture

Routes should be scoped by workspace and optionally page, e.g. `/w/:slug/inbox`, `/w/:slug/calendar`, `/w/:slug/results`, `/w/:slug/p/:pageId/publishing-rules`, `/w/:slug/settings/connections`. Include a workspace switcher, page switcher, and filter for destination. Add `Upload content` and `Find clips` as the two entry actions. Use a clip detail editor, post detail and audit timeline, source watchlist, account connection health, and publishing-rule settings. Use stable query params for filterable lists. Never use a slug as authorization.

Screens must cover loading, empty, partial data, reauthorization, missing rights, manual export, scheduled, in-flight, published, paused, failed, and unknown outcome. Keep application actions keyboard-accessible, provide a Move action alongside dragging, support a mobile agenda view, and preserve focus in dialogs. Show the recipient account, visibility and local time before a user commits. Use plain English initially with localization-ready date/number formatting, IANA time zones and Monday/Sunday preferences. Seed Europe/Berlin for the demo.

### Design implementation

Import `design/relay/relay-tokens.css` and preserve the supplied SVGs as static assets. Treat the HTML guide as a visual reference. Build actual accessible components. Use Ink `#141414`, Graphite `#2B2B2A`, Silver `#C4C5C3`, Sand `#D9CEBE`, Ivory `#F5F2EC`, Porcelain `#FDFCF9`. Use neutral light and dark themes, system sans, tabular numbers, the custom Relay wordmark and silver R tile, and restrained diagonal rules on brand surfaces. Use distinct icons and labels for statuses. Apply the 4 px grid, 8/16/24 px corner tokens, 44 px targets, visible focus, reduced motion and the kit's typography. Use real workspace data in product screens. Clearly identify sample content.

## 3. Architecture and repository

Use TypeScript strict mode throughout. Greenfield defaults:

```text
apps/web         Next.js App Router, React, server-side auth, REST route handlers, UI
apps/worker      Long-lived Node process, task handlers and provider reconciliation
packages/domain  Entities, schemas, policies, scoring, scheduling, transitions
packages/db      PostgreSQL schema, SQL migrations, repositories, transaction helpers
packages/providers  Auth, metadata, publishing, metrics, source adapters and demo
packages/media   FFmpeg and ffprobe runner, formats, filter graph builder, storage I/O
packages/ui      Relay tokens, logo files, primitives and product components
docs/            Setup, security model, provider matrix, release and incident runbooks
infra/           Docker Compose for dev, Dockerfiles, production deployment example
```

Use pnpm workspaces, a pinned supported Node version, lockfile, PostgreSQL, Zod schemas, and parameterized SQL via a typed query layer such as Drizzle with checked SQL migrations. Use Graphile Worker or an equivalent PostgreSQL-backed queue with transactional enqueue on the same DB connection as the business write. Pin the queue library and its schema migration version. Avoid introducing Redis, a message broker, or a separate microservice per integration in the initial release. Store media in a private S3-compatible object store (e.g. MinIO locally and AWS S3 in production) using AWS SDK v3. Stream file data. Keep DB rows for metadata only. Use Vitest for units and integration tests and Playwright for browser tests. Docker Compose should run PostgreSQL and object storage, provision buckets and CORS, and document how to start web and worker. Containers must have health checks and deterministic startup instructions.

Use an established session/OIDC library or existing repo auth. Application sign-in is distinct from linking a social account. Session cookies are secure in production, HTTP-only, same-site as compatible with the flow, and rotated on sign-in. Use an explicit local demo user bootstrap for development and tests. Production must fail closed if demo auth or default secrets are configured. Protect mutations with session checks and CSRF defenses appropriate to the auth implementation. Use separate DB roles for schema migration, application, and job execution. Run web and worker as separate processes with a shared DB and object store. Use a dedicated media worker pool or queue with capped process concurrency so long encodes do not starve publish and reconciliation jobs. No serverless request must hold open while a video processes.

### Core design boundaries

- Route handlers parse, authenticate, authorize, and invoke a domain command. Commit the write, audit event, and queue enqueue together. Return `202 Accepted` with a job/resource status link for expensive tasks. Client updates via bounded, backoff polling initially. Use a consistent error envelope `{code, message, fieldErrors?, retryAfterSeconds?, requestId}`. Map policy and provider failures to actionable codes. Never expose credentials or opaque upload session URLs in client errors.
- Use interfaces at the storage, provider, and job boundaries. Avoid inheritance-heavy provider SDK wrappers. Keep scheduling and scoring pure and independently testable. Inject clock, RNG seed, ID generator or provider fake where needed.
- Postgres is authoritative for entities, reservations, publish ledger, leases and task status. Queue retries only repeat idempotent units of work. Do not use in-memory timers as the durable scheduler. Outbound provider calls occur outside DB transactions. Persist intent before the call and persist its receipt/checkpoint after it.
- Separate platform capability from feature visibility. Effective capability is the intersection of implementation, deployment enablement, provider program approval, granted scopes, account type, requested format and visibility, policy rules, and runtime provider response. Missing capability has a specific user-facing reason and an available fallback where appropriate.

## 4. Domain model, invariants and access

Use UUID internal IDs, opaque string external IDs, UTC `timestamptz` for instants, IANA zone identifiers, integer millisecond offsets for media and bounded numeric/decimal values for metrics. Use enums or check constraints for lifecycle states and precision-sensitive fields. Define migrations and indexes for the following logical records.

| Domain | Records and constraints |
|---|---|
| Identity | `users`, `workspaces`, `workspace_memberships`, `invitations`. Unique membership on workspace/user. Expiring hashed invitation tokens. Roles Owner, Admin, Publisher, Editor, Viewer. Last owner protection. |
| Pages | `pages`, `page_destinations`, `page_policy_revisions`, `brand_presets`. Logical page can map to several accounts. Each publication targets one immutable destination ID. Store goals, cadence, topics, allowed formats, pause generation, and defaults. |
| Connections | `oauth_attempts`, `provider_grants`, `social_accounts`, `provider_capabilities`. Grant can authorize several accounts. Store resolved provider account IDs and exact granted scopes. Unique workspace/provider/provider-account ID. Store encrypted credentials and refresh lease/version. Keep sanitized connection-health reasons. |
| Source rights | `source_channels`, `watch_subscriptions`, `source_references`, `source_rights_grants`, `live_sessions`, `signal_series`, `signal_samples`, `source_alignments`. Deduplicate source within workspace by provider + canonical external ID. Store origin, authorization scope, retention, coverage, rights evidence, version, expiry, and revoke timestamp. |
| Media | `upload_sessions`, `media_assets`, `media_variants`, `clip_candidates`, `clip_projects`, `clip_revisions`, `render_jobs`. Original assets immutable; crop/captions and render profile versioned. Stable hash on revision + output profile + asset version + renderer version; unique successful derivative per render key. |
| Publishing | `campaigns`, `posts`, `post_revisions`, `post_destinations`, `approvals`, `slot_reservations`, `publish_attempts`, `external_publications`, `webhook_receipts`. One outcome per destination and approved intent version. Store external video/post ID distinct from intermediate container/session ID. Unique external publication by provider account and external ID, within workspace. |
| Results | `metric_definitions`, `metric_observations`, `metric_sync_runs`, `campaign_events`, `revenue_entries`, `recommendations`, `experiment_assignments`. Track metric definition and reporting period and observation time separately. Source policy on every imported or computed observation. No rollup without compatible definitions and permissions. |
| Automation and ops | `automation_runs`, `automation_decisions`, `audit_events`, `idempotency_keys`, `usage_events`. Store reasons, rule versions, task checkpoint/status, correlation ID, actor, and stable keys. Avoid retaining provider payloads or secrets in generic JSON. |

- Each tenant record has `workspace_id NOT NULL`. Use composite unique `(workspace_id,id)` keys and composite FKs so a tenant A row cannot point to tenant B. Include tenant scope in all queries, search, analytics, signed URLs, webhook routing and worker lookups. Enforce RBAC in domain commands. For greenfield, use RLS as defense in depth on tenant business tables with transaction-local tenant context and non-owner, non-BYPASSRLS app roles. Bootstrap membership lookups, grant/token access, OAuth state and webhook routing through tightly scoped server-only repositories. Workers establish tenant context from validated task identity, never from arbitrary external IDs. Test RLS, pool reuse, worker scope and composite FK failures with real Postgres.
- Owners/admins manage people, connections and auto-publish activation. Publishers approve/schedule/publish on assigned pages. Editors create/edit/export when allowed by source rights and submit for approval. Viewers are read-only. Avoid leaking existence on cross-tenant IDs. Verify scoped page access at each API, background task, and download.
- Store immutable creative revisions with media version, ordered carousel assets, caption, title, metadata, visibility, creator declarations and destination. Editing an approved payload creates a new version and invalidates its approval. Bind approvals to the complete normalized publish intent, actor, timestamp, and current applicable rights/policy revision. An optional approved time window must be explicitly recorded. Schedule edits outside it require new approval.
- Store a provider origin with source URL, source ID, uploader, capture start/offset, and content permissions. Permissions have separate view, edit, export, publish and commercial-use decisions, permitted destinations, start/end, grantor, evidence pointer, and revoke status. A connection or a public URL is neither a license nor a declaration. Uploaded first-party media requires an ownership/authorization declaration, with client rights configurable per page. Check all upstream video, audio and overlay rights before exporting or publishing, including inherited revocations. Revalidate at execution time. Share timestamp references without making the media public.
- Use optimistic `version` checks for concurrent edits. Idempotency records for create/schedule/upload-finalize return the original response on identical input; reject reuse with a different normalized payload. Scope by tenant and operation with appropriate retention.

## 5. API contract and events

Design REST endpoints under `/api/v1/workspaces/:workspaceId` and document request/response types or generate an OpenAPI spec from shared schemas. Paginate with stable cursor keys (`createdAt,id` or equivalent), limit ranges, and return per-item outcomes for bulk actions.

```text
POST   /uploads                         reserve quota and start upload
POST   /uploads/:id/parts               sign allowed part number range
POST   /uploads/:id/complete            commit uploaded parts and enqueue probe
DELETE /uploads/:id                     abort incomplete upload
POST   /sources/resolve                 canonical URL -> reference and capabilities
POST   /sources/:id/attach-recording    attach asset and alignment
POST   /sources/:id/analyze             enqueue policy-permitted analysis
GET    /sources/:id/candidates          explainable candidate list
POST   /clips                           create clip from a candidate or manual range
PATCH  /clips/:id                       create revision with optimistic version
POST   /clips/:id/renders               render requested revision and profile
POST   /clips/:id/exports               check rights, mint short-lived download
POST   /posts                           create draft with destinations
POST   /posts/:id/submit                 request review
POST   /posts/:id/approvals              approve/reject a revision and destination intent
POST   /recommendations/slots           propose time slots, no write to calendar
POST   /post-destinations/:id/schedule   reserve slot and enqueue durable publish workflow
POST   /post-destinations/:id/cancel     cancel unclaimed intent and release reservation
POST   /post-destinations/:id/retry      resume only from verified checkpoint
GET    /calendar                       bounded date range, time zone and page filters
GET    /results                        supported metrics, as-of date and availability
GET    /jobs/:id                        durable workflow state/progress
POST   /connections/:provider/start    begin server-bound OAuth attempt
GET    /connections                    account and capability health
DELETE /connections/:id                 revoke/disconnect and reconcile affected work
PUT    /pages/:id/publishing-rules      create policy revision
POST   /pages/:id/pause                 bump generation, stop new dispatch claims
```

Use global callbacks `/api/oauth/:provider/callback` and `/api/webhooks/:provider` with provider-specific verification and tenant routing derived from stored attempts/subscriptions. Register explicit event schemas, e.g. `upload.completed`, `asset.validated`, `source.discovered`, `clip.rendered`, `intent.scheduled`, `publish.reconcile.requested`, `publication.confirmed`, `metrics.refresh.requested`, `rule.run.requested`. Treat event payloads as minimal ID/version pointers. Use a transactional enqueue or outbox. On duplicate deliveries, no duplicated business effects.

## 6. Media ingestion, analysis and clipping

### Uploads and formats

1. Accept supported video, audio where useful for analysis, image, carousel, and optional captions. Configure MIME allowlists, max bytes, source duration, input dimensions, media count and workspace quotas. Use a conservative initial video cap such as 4 GiB and four hours, configurable. Reserve bytes and encode budget before issuance. Validate actual content with media probing and image decoding. Reject mislabeled, encrypted, oversized, malformed and unsupported inputs.
2. Use private immutable object keys generated by the server (workspace/asset/version). Use scoped presigned PUT or size-constrained signed POST for small assets, multipart for large assets, bounded TTL and concurrency, and upload retry/progress. Bind expected content length or enforce size at the ingress boundary where supported. Always enforce caps again on object inspection and clean up oversized or incomplete objects. Track S3 upload ID and server-generated part numbers. Server verifies ownership, upload state, expected total size, checksums where supported, ordered part records, and final object HEAD before transitioning to ready-for-probe. Multipart ETags are not treated as content hashes. Use conditional writes/versioning or one-time object keys so a late PUT cannot replace validated media. Abort expired multipart sessions and clean orphan objects. Keep uploads quarantined until validation.
3. Run `ffprobe` and FFmpeg in a non-root resource-limited worker environment with no arbitrary network inputs. Fetch validated object versions to isolated scratch using storage credentials before running the media binary. No shell interpolation. Build argv and filter graphs from typed ranges and a small allowlist; escape paths generated by the app. Restrict allowed protocols/demuxers; disallow remote playlist expansion and nested file access. Limit bytes, streams, pixels, duration, CPU, RAM, temp storage, output size and time. Kill process group on timeout; clean temp files. Harden and patch container and FFmpeg build. Include an OSS/license review for your packaged encoder.
4. Produce playback proxies, thumbnails, audio envelope and waveform. Store input and output probe metadata and FFmpeg/build version. Handle VFR, nonzero starting timestamps, rotation metadata, odd dimensions, absent audio, long GOP, and timebases. Test trim endpoints against synthetic timecoded fixtures. Use optional audio mapping. Render accurate in/out by decoding and re-encoding rather than depending on keyframe-aligned copy. Use reasonable keyframes and `faststart` for MP4. Default vertical delivery H.264/AAC MP4, 9:16, 1080×1920 when source quality and destination allow, `yuv420p`, constant output frame rate when required. Support original ratio and square presets. Validate per destination before rendering or scheduling; never hardcode one platform's limits as global.
5. Non-destructive editor records `startMs` inclusive and `endMs` exclusive, crop mode (fit, fill, or manual), optional time-keyframed anchor, image overlay preset, editable subtitle track and optional title card. Preview uses the same geometry and timing rules as rendering. Support SRT/VTT import and manual captions. Validate cue lengths, encoding, timings, line breaks, and ordering. Use bundled/licensed fonts and safe style tokens. Render burn-in captions or export sidecar according to profile. Keep original and derivatives linked. Rights and workspace checks also apply to signed preview/export URLs.

### Link resolution and stream signals

Resolve exact allowlisted hosts and resource patterns, e.g. YouTube watch, live, shorts and short-link IDs, and Twitch channels, VODs or clips. Use the URL parser, normalize query parameters, validate ID grammar, and construct requests to official endpoints with extracted IDs. Accept start offsets as metadata. Unsupported or disabled integrations can save a reference and attach authorized media. Never make a general-purpose URL downloader, follow user URL redirects, discover HLS manifests from HTML, harvest replay chat from private endpoints, record protected feeds, or use browser session cookies. Provider-approved signed media downloads use a separate restricted code path with validated host and redirect rules.

- Discover approved channels via platform events and bounded reconciliation polling. Track a last-seen cursor/ID with overlap for out-of-order events; deduplicate by provider/event/entity. Active capture starts when authorized monitoring starts. Track observations and gap intervals with UTC event timestamps, ingest timestamps, source provenance and sample interval. Use reconnect with bounded backoff and resume tokens where supported. Don't impute historical viewer curves.
- Consider separately: **audience size** (observed concurrent count), **audience change** (rise relative to local baseline), **reaction** (chat/reaction activity if allowed), and **footage cues** (laughter-like acoustic energy only as a proxy, scene changes, onset, motion, cue markers, manual or creator timestamps). Broad views/likes from a public VOD do not reveal a moment-level reaction history. Store enough coverage to tell missing data from zero. Rate-limit samples and treat viewer counts as sparse observations.
- Map stream wall time to recording timeline using a versioned alignment with anchors and tolerance. Start with a user-confirmed sync offset and add a second anchor where drift matters. Treat a recording cut or stream restart as a new segment. Check timestamps outside the aligned range and label low confidence. No automatic clipping based on a misaligned or untrusted timeline.
- Data policy is independent of the user's rights. Tag each input with provider, acquisition method, owner, purpose, allowed operations, and expiry. Apply the policy before retaining, deriving, displaying, exporting or learning from any signal. Creator-provided platform exports retain their provenance. They cannot be used to bypass restrictions on provider data. First-party telemetry from the creator's own authorized capture or website and user-authored markers can be supported independently.

### Deterministic highlight ranker

Implement a baseline usable without provider signals. Generate feature windows over the authorized recording via FFmpeg, with bounded sampling (e.g. 5 s windows and 2.5 s stride), scene changes, audio envelope/onset, silence boundaries, and manual markers. For allowed reaction and concurrent series, compute local robust anomaly scores over a configurable rolling baseline using median and MAD with a noise floor. Count distinct contributors only where permissible and retain only permitted aggregates. Suppress single-account bursts where you can validate them, clip outliers, mark sample coverage, and distinguish a peak audience from a burst.

Map valid features to comparable bounded ranges. Combine available weights and renormalize over eligible signals; separately compute coverage/confidence and prevent low-coverage windows from looking certain. Example initial weights: reaction 0.35, concurrent change 0.15, source cues 0.35, editorial markers 0.15; a manual marker can also bypass ranking as a user intent. Keep a ranker version and persist a concise reason with exact contributing evidence where display is permitted. Collapse overlapping candidates (e.g. IoU > 0.5), cap candidates per source and per segment, and pad starts to the preceding setup and ends to include payoff. Use configurable 15–60 s defaults and allow manual adjustment. Offer more than one cut only when they are meaningfully different. Add review feedback (accepted, trim adjusted, missing context, wrong fit, rights issue). Record it as Relay first-party data. Require review for ambiguous ranges, insufficient coverage, missing rights, or newly enabled formats.

## 7. OAuth, webhooks and provider contract

Define independent interfaces for authorizing accounts, resolving/monitoring sources, publishing, and reading metrics. A platform may implement any subset. Make the task worker use the same capability gates as HTTP actions.

```ts
type Capability = {
  state: 'enabled' | 'disabled' | 'missing_scope' | 'needs_review' | 'not_supported';
  reasonCode?: string;
  checkedAt: string;
};
type PublishPhase =
  | 'prepare' | 'transfer' | 'wait_processing' | 'dispatch' | 'confirm';
type PublishCheckpoint = {
  phase: PublishPhase;
  receiptId?: string;         // provider container/video ID or internal receipt pointer
  providerPostId?: string;    // populated only once known
  nextCheckAt?: string;
};
interface PublishingAdapter {
  capabilities(account: ConnectedAccount): Promise<PublishingCapabilities>;
  validate(intent: PublishIntent, caps: PublishingCapabilities): ValidationResult;
  advance(input: {
    account: ConnectedAccount;
    intent: Readonly<PublishIntent>;
    checkpoint: PublishCheckpoint;
    operationId: string;
  }): Promise<StepResult>;
  reconcile(input: ReconcileRequest): Promise<ReconcileResult>;
}
```

Define `StepResult` as a tagged union of continue, waiting, confirmed, rejected, rate-limited and unknown. Keep signed upload URLs, tokens, cursors and provider error payloads outside shared types sent to clients. Retry using documented provider semantics. Keep ability to report the last attempted phase.

- Use OAuth authorization code flow with PKCE S256 where supported, one-time server-side state bound to user, workspace, provider, intended purpose and exact redirect URI, and strict callback allowlists. Keep short attempt expiry, consume state once and validate current membership. Add nonce for OIDC where applicable. Resolve provider identity/accounts server-side and let the operator choose. Require incremental scopes for publishing, insights, monetary metrics and chat as separate capabilities. Persist granted scopes and token expiry, separate app and user tokens, and support account removal without accidentally removing other connections sharing a grant.
- Encrypt access/refresh tokens and resumable secrets with authenticated envelope encryption backed by production KMS. Bind ciphertext to tenant, provider and grant ID using authenticated associated data. Separate local dev secrets. Never persist plaintext in SQL, job arguments, URLs shown to users, observability or analytics. Implement single-flight refresh via a short DB lease with version/CAS and fenced updates; use timeouts and avoid lock-held provider calls. Persist rotated refresh tokens atomically. If response is lost and token status cannot be proven, require reconnect instead of unbounded rotation attempts. Revalidate granted scopes/health, handle invalid_grant and revocations, and invalidate dispatch eligibility.
- Webhooks: verify raw body signatures (with constant-time comparison), timestamp/replay protection, challenge handling, content type and body size using provider rules. Acknowledge only after durably recording/deduplicating the event or enqueueing in the same transaction. Resolve external IDs through authoritative subscription mappings; never accept a tenant ID from an untrusted payload. Treat unsigned or weakly authenticated notifications as hints requiring an official refetch where supported. Bound payload retention, disable XML external entities, support duplicate/out-of-order events, subscription renewal/revocation and reconcile periodic misses.

## 8. Provider implementation matrix

Implement YouTube as the first real video publishing destination. That exercises the existing stream-link flow and yields one coherent vertical slice. Implement Instagram next for marketer uploads and Reels, then add the Facebook Pages, Twitch source, and TikTok adapter milestones below. A workspace without connected accounts must still support local content, clips, planning, and rights-aware export. An unsupported destination shows its fallback. Never label a native handoff as an automatic publish.

### YouTube · source, video publishing, and insights

- **Setup:** Configure a Google Cloud project, YouTube Data API v3 and YouTube Analytics API, consent screen, exact redirect URI, test users and production OAuth verification or other reviews as applicable. Request `youtube.upload` for uploads and the documented minimum additional scopes for channel resolution, status, later edits and Analytics. Separate Analytics read and monetary scopes. Resolve the YouTube channel under OAuth, not merely the Google identity. Verify the destination ID returned on publish.
- **Sources:** Use `videos.list` for metadata and `liveStreamingDetails`, plus documented owner-authorized endpoints where appropriate. Use the active chat ID and `liveChatMessages.streamList` or a documented polling fallback at its advised interval. Treat `concurrentViewers` as an optional current sample, never a historical series returned for completed streams. WebSub upload/metadata notifications are discovery hints and do not guarantee a live lifecycle. Re-fetch by ID, deduplicate, and use quota-budgeted polling for watchlists when needed. For finished videos, use timestamp review and authorized media input. Never download audiovisual bytes from YouTube via unofficial methods or assume an owner OAuth token grants download permission. Use the creator's own original recording or a supported authorized supply route.
- **Publishing:** Use OAuth `videos.insert` with resumable upload. Persist the upload session URL as an encrypted, short-lived secret and reconcile the byte range before resuming. Save provider video ID immediately and use `videos.list`/processing details when allowed. Send visibility explicitly. Initial public staging flow is disabled unless deliberately enabled. YouTube's 2 November 2026 revision reversed the older blanket private-only restriction on unverified project uploads. Verify actual project, account, quota and policy behavior in staging. Preserve the separate TikTok requirements. Respect audience and disclosure fields, preserving the operator's explicit declarations. Upload compatible vertical videos and let YouTube determine Shorts classification. Treat Shorts classification as a provider outcome. [YouTube API revision history](https://developers.google.com/youtube/data/revision_history)
- **Timing:** For V1, pre-stage a private upload if scopes and the explicit workflow support it, then dispatch visibility through Relay at the due time. Otherwise start the authorized upload at the due time and communicate processing delay. Recheck the correct account, immutable intent and rights before public visibility. If using provider-native `publishAt` later, it is for eligible private, never-published videos. Validate future instants. Model external schedule cancellation, edits and reconciliation separately. A local cancel alone cannot stop a provider-native schedule. Ship that path only after those tests pass.
- **Results:** Use `reports.query` for authorized metrics with allowed dimension/filter combinations, plus supported Data API fields. Store API version and metric definition. Treat Data API view counts and Analytics metrics such as engaged views as distinct. Use quota-aware batches, reporting date windows and actual available dates. Do not display revenue, retention, subscriber attribution or post-level metrics that the grant/report cannot return.
- **Data use:** Gate advanced ranking, timing analytics, derived metrics, aggregation, and longer retention on documented permitted use and any applicable YouTube Analytics & Reporting amendment acceptance. Start with owner-visible provider-returned metrics, separately labeled. Do not feed YouTube API data into Relay's derivation pipeline by default, including reaction scores, model training or recommendations. The scheduler still works from Relay first-party operational data, user goals, explicitly allowed first-party telemetry and editable defaults. Apply expiry and periodic refresh/deletion by policy class. Never blend YouTube stats with other platforms into a synthetic engagement total or leaderboard. Implement any later accepted use only within the approved purpose and scope. [YouTube derived metrics and storage policy](https://developers.google.com/youtube/terms/derived-metrics-policy)

### Instagram · original media, Reels and insights

- Choose Instagram Login for the first Instagram adapter. Target eligible professional accounts. Use the current Instagram Login token host, account resolution, grants, and documented refresh path consistently. Start with `instagram_business_basic` and `instagram_business_content_publish` for publishing and confirm the insights scope and endpoint for the chosen app/Graph version before enabling reads. Treat Instagram Login and Facebook Login as distinct connection variants. If adding the Facebook Login variant, verify linked professional-account/Page prerequisites and its distinct scopes, account mapping, tokens and API host. Never interchange Page tokens and Instagram Login tokens.
- Gate external customer access on applicable Meta App Review/advanced access and deployment mode. Detect account type, app roles and missing scopes. Publish via media container creation, validated accessible media URL or documented upload path, processing polling and publish, retaining container ID, published media ID and results independently. For carousels, create eligible ordered children, then the parent container. Validate mixed asset support against the pinned Graph version. Track container and asset URL expiry and prepare near due time with an appropriate lead. An expired uncommitted container can be recreated only if no publish outcome is ambiguous. Poll on the documented interval, check content publishing limits and expose Reels-specific duration/codec constraints in capabilities.
- Provider media fetch requires a reachable HTTPS URL for approved formats where applicable. Use a bounded capability URL minted for the exact immutable variant on an approved media origin, with adequate TTL for fetch/processing and no directory listing. Log only a non-secret reference. Leave the object bucket private. Test actual reachability in staging. Use documented account and media insights only. Keep reach, views, impressions, replays, interactions, and unavailable metrics distinct, versioned and appropriately attributed.

### Facebook Pages · separate destination

- Use Facebook Login for Business or the current documented Page access flow, enumerate allowed Pages and tasks with user consent, and use a scoped Page token for posting. Verify current permissions, app review and Page role requirements in Meta's console. Never publish to a personal profile. Model `facebook_page` separately from `instagram` even if they share a Meta Business Portfolio.
- Implement Reels with the documented `video_reels` start/upload/finish flow, verify processing, and persist video ID before finish. Add feed image/link support only after the account and version support it. Fetch Page or post insights separately if entitled. Reconcile by returned external ID rather than assuming an HTTP success means visible on the Page. Expose unsupported formats as manual export.

### Twitch · creator-approved source

- Set up Twitch app registration, authorization, EventSub callback or an allowed WebSocket flow, and documented scopes for each action. Use Helix channel lookup, `Get Streams`/VODs, authorized chat EventSub, and online/offline notifications. Sample viewer counts at a quota-safe interval. Keep read monitoring separate from creating a native clip.
- Prefer creator-owned recordings. Where the broadcaster or authorized editor grants the required capabilities and external usage rights, support native `Create Clip`, `Create Clip From VOD` and `Get Clips Download` through Helix as separate optional actions. Use the documented ID, offset semantics, scope, editor relationship and temporary URL rules. Poll for clip readiness and validate media rights/authorization before any import or export. Treat creating a native clip as a visible platform write and require explicit authorization for that action. Provider access is separate from repost/commercial permission. No arbitrary VOD extraction or fabricated download URL.
- Verify EventSub signatures and timestamp, challenge response, subscription revocation, and delivery ID deduplication. Keep chat tracking opt-in and avoid retaining raw chat or user identities by default.

### TikTok · explicit user flow and capability gate

- Configure a TikTok developer app, Login Kit, relevant posting scopes and review. Ship manual export first. Implement a deliberate, audited Direct Post flow only when the app and user are eligible. Fetch current creator info at review time; display account, preview, editable text, permitted visibility, disclosure and interaction controls. Capture provider-required explicit consent for the exact item. Recheck relevant capabilities before dispatch, use documented `FILE_UPLOAD` or verified-domain `PULL_FROM_URL`, and persist the publish ID. Poll status or use documented events to resolve the provider outcome. Unaudited direct posting has private restrictions. [TikTok Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)
- `video.upload` inbox upload is distinct from Direct Post. Clearly label it as a handoff requiring completion in TikTok. Do not mark it published. Keep unattended TikTok publishing disabled unless the actual approved use case and provider UX/consent requirements allow that exact workflow. TikTok's guidelines emphasize authentic creators, original content and a broadly available app. Don't assume Relay's clipping or private-team workflow qualifies. Maintain manual export for unsupported use. Use authorized Display API metrics where allowed (e.g. documented video fields via `video.list`) and expose only the metrics returned for that account. [TikTok Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)

### Connection setup and feature availability

Maintain `docs/providers/<provider>.md` with setup screens, products/APIs to enable, exact callback URI, app mode, consent requirements, requested/granted scopes, token lifetime strategy, webhook registration, format/visibility matrix, rate/quota limits, review status, data retention, policy links, and staging smoke steps. Keep separate credentials and webhook secrets for each environment. Never expose provider console credentials in the browser. Include per-provider enabled and disabled reasons in the workspace. Validate startup config and let demo mode run without real credentials. Use recorded sanitized payload fixtures and contract tests to catch schema drift. Live mode cannot silently fall back to a fake adapter.

## 9. Calendar, execution and failure semantics

**Calendar model:** Store proposal and reservation separately. Use UTC for persistence and IANA zone for local cadence and display. Record the civil timestamp/offset and zone selected by the user. Use Temporal or an equivalent explicit zone conversion with tests. Reject nonexistent wall times or ask the operator to choose a valid time. For fall-back ambiguities, present offsets or apply a documented, deterministic selection only when scheduling rules explicitly allow it. Existing schedules retain their chosen UTC instants when a page zone changes unless explicitly moved.

- Consider required campaigns/dates, locked slots, day-of-week/time windows, account min spacing, per-day/week caps, media readiness lead, quiet hours, platform quotas, rights expiry, page goal and page-destination content balance. Check constraints in the scheduling transaction. Lock the account row to serialize scheduling decisions for the same destination, including across logical pages in the workspace; lock accounts in sorted order for multi-destination operations. Add an exact-slot uniqueness constraint on active reservations as a backstop. Protect quota and min-gap checks against races. Never assume a slot recommendation has reserved anything. Support atomic single-destination changes and explicit partial results for batch schedules.
- Use immutable `intentVersion` and stable publish operation key `workspaceId:destinationId:revisionId:intentVersion`. Before scheduling, verify approval scope, rights, media readiness, connection and visibility. Atomically persist reservation, audit and durable run-at task. At execution, reload current state and refuse stale job version, canceled or superseded intent, paused generation, expired authorization, changed rights, unapproved visibility, invalid media, or over-late schedule. Use configurable late grace/catch-up rules. Missed schedules beyond grace go to review. Preserve original planned time and actual observed published time.
- Use destination states with an explicit transition table, e.g. `draft → needs_review → approved → scheduled → preparing → dispatching → processing → published`. Allow terminal `canceled`, `failed_permanent`, and `expired`; use `blocked` for reconnect/rights/pause and `needs_reconciliation` for ambiguous delivery. Some adapters prepare/process before dispatch and confirm after. Model that with checkpoints rather than lying about a universal sequence. Roll up mixed destination statuses in the post UI. A successful upload can still be pending processing or private. Mark published only when the intended destination, visibility and provider outcome are confirmed.
- Dispatch state machine: claim with a compare-and-set and fenced lease, persist request fingerprint and provider checkpoint before side effects. Use provider idempotency keys only where documented. For a request timeout or crash after transmission, stop new create/publish attempts until reconciliation proves the outcome. Resume a known resumable session or look up a saved external receipt. If the provider cannot distinguish succeeded from not sent, freeze in `needs_reconciliation` and require operator inspection. Never silently send again or match just by post title. Allow an authorized operator to link a verified external post ID or close the incident with a recorded reason. At-least-once queue semantics are expected; do not promise exactly-once effects across third-party APIs.
- Retry only operations known safe to replay. Honor provider `Retry-After` and rate-limit headers; use bounded exponential backoff with jitter, caps, provider/account token buckets and circuit breakers. Distinguish retryable transient error, provider quota, token expiry, invalid grant, unsupported content, policy denial, duplicate webhook, and unknown external outcome. Store actionable error codes. Expose retries and remediation per destination, with no duplicate scheduling of already confirmed destinations. Put expired jobs into a recoverable ops view and run a periodic stale-intent/expired-lease reconciler.
- Pause/revoke/cancel invalidates new dispatch claims. Serialize the final policy check and claim against the relevant page/connection/rights generations in Postgres. Recheck before the public side effect. Use the committed final claim as the dispatch boundary. A pause that wins before the claim prevents dispatch. A claim that wins before pause is in flight from the application's perspective, even when the HTTP request has yet to complete. Reconcile and show its outcome. If provider-native scheduling is supported, cancel it at the provider and confirm the result. Guard against multi-worker duplicate claims and publish being triggered twice after a process death.

### Transaction and checkpoint sketch

```text
schedule(workspace, destination, expectedVersion, approvedIntent):
  transaction (tenant context):
    lock account, page, destination in the documented lock order
    compare current version and approval payload hash
    verify readiness, applicable policy and rights generations
    reserve UTC slot and check account pacing under the account lock
    insert immutable intent and append audit event
    enqueue prepare or dispatch with intent ID, version, and run_at
  return intent and reservation

advance(intentId, intentVersion):
  transaction (validated tenant context):
    reload intent, account, policy and rights
    return on terminal outcome, stale version, or blocked eligibility
    reject expired worker ownership or acquire a new fenced claim
    if previous attempt may have sent a request: enqueue reconciliation only
    else write step/operation receipt and commit dispatch claim
  call provider outside transaction with a strict timeout
  transaction:
    conditionally persist checkpoint/result using attempt ID and fencing token
    schedule next step, reconciliation, or metrics only from legal transitions
```

A worker that loses its lease cannot commit a stale result. A lease expiring after a provider request is never proof that the effect did not happen. Store enough sanitized receipt information to reconcile it. Document the lock order across schedule, cancel, claim and rights revocation. Provider-wide quotas and rate budgets must span workspaces where the provider applies them. Keep them internal so customers cannot infer another workspace's activity.

## 10. Analytics, recommendations and creator monetization

**Metrics ingestion:** Schedule policy-compliant metric syncs after confirmed publishing. Support configurable observation ages (e.g. around 24 h, 72 h, 7 d and 30 d where possible). Store `providerMetricKey`, definition version, unit, entity, provider date window/zone, reporting grain, `observedAt`, `publishedAt`, `value`, availability/reason, provenance, consent/retention policy, and source endpoint. Distinguish observed counts from period aggregates and estimated values. Use nullable availability with explicit codes `not_supported`, `missing_scope`, `not_yet_reported`, `expired`, `rate_limited`, `suppressed`. A true zero remains numeric zero. Late data and revisions are allowed. Use idempotent upsert keyed to stable observation identity and never sum repeated cumulative snapshots. Use latest valid data for current counts. Preserve snapshots only where allowed.

**Results UI:** Filter by page, platform, period, goal and format. Compare posts at a comparable age/tolerance with the same metric definition and unit, show cohort size and coverage, and display platform labels and freshness. Render separate panels if definitions differ. Label subscriber/follower counts as post-attributed or page-level according to source. Distinguish rates calculated by a provider from Relay-calculated values and show denominators where permitted. If retention, saves, or conversions are unavailable, say so. Keep campaign KPIs and creator revenue separate from platform reach.

**Timing recommender:** Use goal-driven ranking where data use is permitted. Candidate slots come from civil time windows, constraints and editorial priority. Start from editable per-page posting windows and label cold-start recommendations. Never claim a perfect time or imply a causal lift from observational data. A practical first implementation:

1. Segment by page/destination, format, goal metric, day group/hour block and an age-aligned outcome window. Exclude unavailable metrics, stale/confounded fixtures, paid campaigns if analyzing organic content, and prohibited data. Store cohort and algorithm version. Filter before scoring.
2. Use a robust average/median for a matching slot and a broader page/format prior. Shrink small samples toward that prior, e.g. `(n * robustSlot + k * pagePrior) / (n + k)`, with configurable prior strength. Require a minimum cohort and valid age coverage before describing the timing as data-backed. Add recency weighting only when validated. Separate high-performing formats from time effects and keep campaign deadlines as constraints.
3. Penalize saturation and protect pacing. For consented experiments, reserve a small configurable portion of flexible posts for alternatives, with seeded assignment, an eligibility rule and a holdout. Never move fixed campaign launches for an experiment. Expose a reason, time zone, data origin and sample size for each suggestion. Include fallback reason if no cohort is usable. Save manual overrides.
4. Report outcomes by objective (reach, watch time, followers, campaign conversions) and evaluate at comparable observation ages. Record experiment exposure and source lineage for a post. Learn within a page and its authorized data scope. Use testable heuristics first; never tune policies based on a single breakout post. Surface recommendations such as “try another clip in this series” by matching authorized content tags and measurable page performance, with operator review.

**Conversions and revenue:** Generate editable UTM templates with safe URL encoding and preview. Support CSV entry/import and an optional first-party event ingest for a site the operator controls. Sign event requests, deduplicate external conversion IDs, minimize personal data, require consent where applicable, and document attribution windows and limits. For revenue store decimal amount, ISO currency, date, source category (platform, sponsor, affiliate, direct), status (estimated, recorded, reconciled), optional related post/campaign, and source. Preserve original currency and never silently combine currencies or present estimates as payouts. Show only API-authorized monetary metrics and otherwise allow user entries. Treat program eligibility and content ownership as separate from performance. SaaS billing, if requested later, is a separate concern with usage metering and entitlement interfaces. Core operations require no payment provider.

## 11. Publishing rules and supervised automation

Implement one orchestrator for monitored sources and another task entry for finished uploads. Both create normal drafts and use the same rights checks, rankers, render pipeline, reservation service and provider adapters. No separate automation path may bypass policy.

1. **Suggestions only:** Watch approved channels, attach authorized recordings where a creator supplied them, detect eligible moments or slot options, and suggest timestamped drafts. Never dispatch a social write.
2. **Queue for approval:** Create clip candidates, render eligible versions under budget, assemble page-appropriate drafts, and propose a calendar batch. Surface source rights, publishing account, confidence, reason, timing and content mix. Human approval unlocks scheduling according to the normal workflow.
3. **Auto-publish:** Default off. Owner/Admin activation is per page, per approved source or upload workflow, per destination and format. Require a policy revision including eligible rights, destinations, thresholds, cadence, timezone, budget and expiry. Allow only providers supporting the actual approval/consent mode. Use an explicit service actor and rule authorization for eligible immutable intents. Treat unknown sources, new types, low confidence, policy changes, rights exceptions and provider declarations as human review. Never enable it automatically from KPI success.

Run watchlist and policy tasks with checkpoint cursors, per-source leases and `UNIQUE(page_id, source_id, candidate_version, rule_revision)` or equivalent logical key. Deduplicate ranges and post fingerprints, cap clips per source/page/day, avoid repeated footage to the same account, and allow one source to yield tailored clips for different authorized pages. Respect page content pillars, tags, minimum gaps, protected campaign dates, existing manual uploads and a maximum percentage of automatic slots. Apply backpressure to renders, provider rate limits and spend. Include an operator-visible decision log, page/workspace pause, dry-run mode, and kill switch. Default manual sources until consent/permission and representative staging tests are in place.

Log accepted/rejected/edited clips, overrides, page goals, output features and post outcome lineage as first-party operational events. Compare recommendation quality, approval rate and publish reliability. Progress from suggestion to unattended use only after operator approval, adequate evidence from multiple real review cycles, acceptable error rates, and working pause/revocation tests. First pilot one authorized creator feeding two pages with different goals and one marketer scheduling original content. Show that page policy drives different candidate and calendar decisions.

## 12. Security, privacy and production operations

- Threat-model account hijack, cross-tenant object access, forged callbacks, SSRF, malicious video/filter input, credential leakage, duplicate public posting and quota abuse. Apply provider/network allowlists, DNS and redirect validation with private/link-local/loopback/reserved IP rejection for any approved remote fetch, timeouts and byte limits. Never turn an endpoint into an open proxy. Use CSP, output escaping, secure headers, HTML sanitization where relevant, origin checks, CSRF and no PII in test fixtures.
- Restrict media with signed URLs and server-side policy checks, short TTL, exact object version, and no storage bucket exposure. Previously issued links remain usable until expiry unless an application proxy or object invalidation revokes them. Choose shorter TTL or authenticated proxy for sensitive review. Keep media out of logs and analytics. Require verified webhooks and explicit revocation paths. Store sensitive payloads only with purpose-specific retention. Do not log request bodies, URLs with tokens or credentials, raw chat, or video metadata containing private information. Redact upstream error bodies.
- Implement data inventory with `provider_policy_id`, authorization status and `expires_at` on provider data and derived outputs. Centralize capability checks for collect/display/derive/train/export/persist with explicit allow rules. Default deny for unknown classes. Refresh or purge by deadline. Handle revoked authorization, removal and user requests. Remove dependent snapshots/recommendations where required, abort queued work, clean object storage and keep only necessary non-content audit references if permitted. Make deletes restartable and respect provider deadlines. Document backup expiry, access, residency and restore/re-delete procedure. Avoid assuming EU hosting alone satisfies privacy obligations.
- Deploy regional web and worker services, managed PostgreSQL backups, private encrypted object storage, separate queue/media worker concurrency, migration runner, least-privilege IAM, secrets manager/KMS, and TLS. Use health/readiness and graceful worker shutdown, versioned migrations, idempotent deploy setup, rollback instructions and database restore rehearsal. Use staged schema changes compatible with in-flight jobs. No production auto-seed.
- Log structured sanitized correlation IDs, lifecycle transitions and provider latency. Track queue age/depth, scheduler lag, due dispatch latency, render failures, upload durations, provider 429/5xx, refresh failures, webhook lag, rights blocks, unknown outcomes, and egress/storage usage. No high-cardinality or sensitive values in metric labels. Alert on blocked queues, unusually high duplicate/unknown outcomes, quota exhaustion, expiring connections and incomplete deletion jobs. Provide runbooks for ambiguous publishing, outages, rollback, data export/deletion and rotating provider secrets.
- State initial budget assumptions and load-test them. Suggested staging targets are median browsing API response under 500 ms without provider network calls, P95 due job claim within 60 s under representative backlog and rate limits, and responsive progress updates. External processing time is measured separately. Meter media minutes, storage, provider requests and export bytes by workspace. Return quota-exceeded errors before large compute work. No silent billing or live outbound requests in CI.

## 13. Testing and release milestones

Use synthetic video/audio with known timecodes and visual/audio peaks, sanitized provider response fixtures, a deterministic clock and scheduler, and separate test tenants. Unit-test pure logic and run integration tests against real PostgreSQL and object storage. CI must use fake providers, without production credentials. Add schema, typecheck, lint, unit, integration and Playwright checks. Test same workflow with theme and accessible keyboard flows.

| Milestone | Deliverables and acceptance gate |
|---|---|
| **M0 · Foundation** | Repository, local infra, migrations, secure auth boundary, workspace/pages/RBAC, UI shell and design kit. Fresh checkout runs using documented commands. Two seeded tenants cannot see or mutate each other's records or signed media. Demo credentials fail closed in production config. |
| **M1 · Original content to calendar** | Validated local uploads for video/image/carousel, drafts/revisions, destination preview, approvals, recommendation fallback, durable schedule, fake provider and Results fixtures. Playwright proves upload → approval → schedule → worker → confirmed mock post. Verify pause/cancel, reschedule, mixed outcomes, DST and concurrent slot collisions. |
| **M2 · Source to clip** | URL resolver, authorized file attachment and rights checks, time alignment, deterministic ranker, clip editor with subtitles, rendering, export and calendar handoff. Test a synthetic peak and exact in/out, odd sizes/no audio/rotation, rights revoked after scheduling, missing signals and a public reference without media. |
| **M3 · Real YouTube vertical slice** | OAuth, channel binding, source metadata, resumable upload, processing/status and allowed metrics. Fixture and staging validation of reconnect, forced interruption, unknown publish outcome and explicit visibility. Use test channel and private scope/visibility until a separately authorized live verification. Demonstrate raw Analytics with policy-safe retention. |
| **M4 · Meta publishing** | Instagram professional connection, image/reel/carousel capability, publishing and authorized results; then distinct Facebook Page adapter with Page-scoped Reels. Verify account routing, media URL fetch, missing permissions, expiry, retries, processing and no mistaken personal-profile capability. Actual availability depends on app review and staging verification. |
| **M5 · Sources and additional destinations** | Approved-channel watchlist, live monitoring with gaps, Twitch authorized source/clip access, TikTok manual export and review-gated adapter. Test duplicates/out-of-order webhooks, reconnect, watch permissions and YouTube data-use gate. TikTok requires exact consent behavior and approved use case before enabling any direct post feature. |
| **M6 · Results and rules** | Age-aligned comparisons, first-party conversions/revenue, evidence-backed slots, experiment assignment, decisions and supervised page automation. Verify no learning from missing or prohibited data. Test the two-page pilot and show distinct, traceable choices. Pause prevents new dispatch and reports in-flight work. |
| **M7 · Production readiness** | Load and failure injection, monitoring dashboards, retention jobs, backup restore, least privilege, accessibility, provider compliance matrix and staged deployment runbook. Ship only verified capabilities behind scoped flags. Document the tested limits and owner-controlled enablement. |

**Critical regression tests:** Crash before and after a provider write, repeated 429, partial uploads, concurrent OAuth refresh, token rotation loss, callback state replay, forged webhook, partial batch approval, expired signing URL, change of visibility after approval, cross-tenant path/ID guessing, queue lease takeover, lost response with ambiguous public outcome, rights revocation between preparation and dispatch, and post metrics corrected by the provider. Test that users can always distinguish missing media from missing permission, simulated publishing from live, and a suggested slot from a scheduled post.

**Operational acceptance:** Deliver a seeded example with a marketer scheduling a week of finished posts and a clipper producing three usable clips from a representative source. Measure time and reviewer feedback as pilot benchmarks, e.g. three publishable candidates reviewed within ten minutes after analysis completes. Report render and processing time separately. State what passed locally, what passed in staging, and what awaits credentials or provider approval.

## 14. Setup deliverables and reference material

Provide `README.md`, concise `CLAUDE.md`, `.env.example`, Compose and production example, schema/migrations, a seed and fixture generator, worker task catalog, provider matrix and onboarding docs. Document commands such as `pnpm install`, `docker compose up -d`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`, `pnpm worker:dev`, `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e`. Align names with actual scripts. Explain media cleanup, health, failure recovery, where to inspect jobs and how to switch from demo to a test account.

Group validated config in the env schema:

- Core: public HTTPS URL, application auth/session config, database URLs per role, worker pool and concurrency, demo mode/fixture controls.
- Storage: endpoint, region, private bucket, credential provider, public provider-fetch origin where needed, TTLs, upload/render caps, and separate signing and encryption configuration.
- Integrations: provider client ID/secret and exact redirect URLs, webhook secrets, API versions, per-capability flags and quotas, test accounts and feature enablement. Keep credentials separate from database/audit rows and source control.
- Operations: KMS key ID, telemetry endpoint, log level, policy configuration/refresh deadlines, scheduler grace window and global publish kill switch.

Verify these primary references before choosing endpoint versions, scopes and data handling. Record discrepancies in the provider matrix rather than guessing. Use links to current docs and note the date actually checked.

- Claude Code project instructions and memory. [Claude Code documentation](https://code.claude.com/docs/en/memory)
- YouTube upload, scheduling and the updated verification rule. [Videos insert](https://developers.google.com/youtube/v3/docs/videos/insert) · [Video resource](https://developers.google.com/youtube/v3/docs/videos) · [Resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) · [Revision history](https://developers.google.com/youtube/data/revision_history)
- YouTube discovery and signal APIs. [Push notifications](https://developers.google.com/youtube/data/guides/push_notifications) · [Live chat streamList](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList)
- YouTube Analytics data and usage. [Reports query](https://developers.google.com/youtube/analytics/reference/reports/query) · [Metrics](https://developers.google.com/youtube/analytics/metrics) · [Developer policies](https://developers.google.com/youtube/terms/developer-policies) · [Derived metrics and storage amendment](https://developers.google.com/youtube/terms/derived-metrics-policy) · [Channel monetization policies](https://support.google.com/youtube/answer/1311392)
- Meta professional-account publishing and Facebook Pages. [Instagram API collection by Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) · [Instagram content publishing guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing) · [Facebook Reels collection by Meta](https://www.postman.com/meta/facebook/request/rgkn91u/1-create-reel)
- Twitch watch, native clips and events. [Helix API reference](https://dev.twitch.tv/docs/api/reference/) · [Chat authentication](https://dev.twitch.tv/docs/chat/authenticating/) · [EventSub webhook verification](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/)
- TikTok publishing and analytics access. [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) · [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post) · [Upload handoff](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video) · [Status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status) · [Query videos](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-query)
- Infrastructure and security. [Graphile Worker job keys](https://worker.graphile.org/docs/job-key) · [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) · [S3 multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) · [OAuth Security BCP](https://datatracker.ietf.org/doc/html/rfc9700) · [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

**Start now:** Inspect the repo, write the milestone plan and implementation status, build M0 and M1, run their gates, and report the exact commands and results. Keep the project runnable at the end of the session.
