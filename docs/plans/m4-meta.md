# M4 · Instagram and Facebook Page adapters: build plan

Produced by a planning pass over the codebase on 2026-11-16. A plan, not a record of work done:
progress is tracked in `docs/implementation-status.md`.

## Scope

Plan only; no files were changed. It covers spec sections 7 to 9 and milestone M4 for two separate live adapters: `instagram` (Instagram Login, variant `instagram_login`) first, then `facebook_page` (Facebook Login for Business, variant `facebook_login_business`, Reels only in v1).

**In scope**

- OAuth connect, callback and account choice.
- Envelope-encrypted token storage, refresh and health checks.
- Capability detection for live accounts in web and worker.
- Publishing through the existing `advancePublish` / `reconcilePublish` state machine with no change to its semantics: Instagram image, Reel and carousel via containers; Facebook Page Reels via `video_reels`.
- A bounded provider-fetch media URL minted from the private bucket.
- Insights only behind a flag, after a real run confirms scope and endpoint.

**Out of scope**

- KMS key provider (M3). Production start-up stays blocked; live tokens can exist only in local or staging with the local keyring.
- Webhooks, Facebook feed/photo posts, the Instagram Facebook-Login variant, provider-wide quota buckets and circuit breakers.
- Clipping (M2), planned separately. It also needs the next migration number, so the two plans must agree on numbering.

**Key design decisions**

- Live mode resolves to a real adapter or null (`createAdapterRegistry` already guarantees this). Adapters are registered only when the provider flag is on and credentials are present.
- Tokens and signed URLs never enter checkpoints, job payloads, audit data or logs. Adapters get them through injected accessors.
- Each `advance` call makes at most one provider write, so every step fits the 30-second abort and 120-second lease.
- `mayRunBeforePlannedTime` is false for every phase in v1. Nothing is staged at Meta before the due time; processing delay after it is shown as `processing`.
- A lost response before `media_publish` (Instagram) or before `finish` (Facebook) cannot have produced a public post, so reconcile resumes it. A lost response on the publish call itself is resolved only by an ID lookup on the saved container or video ID, otherwise it goes to the operator.

**Source caveat**
Meta's documentation was unreachable in this environment. Every endpoint, host and limit below comes from search summaries and must be checked against the live docs and the staging run. Nothing may be marked contract-tested (recorded) or live-verified until the operator's real run.

## Steps

### 1. Config, provider credentials and start-up rules

**Files:** `packages/config/src/env.ts`, `.env.example`, `packages/config/src/env.test.ts`

Add these variables:

- `RELAY_META_GRAPH_VERSION` (default `v26.0`).
- `RELAY_PROVIDER_INSTAGRAM_APP_ID`, `RELAY_PROVIDER_INSTAGRAM_APP_SECRET` (the Instagram app ID and secret from the Instagram product page, not the Meta app ID).
- `RELAY_PROVIDER_FACEBOOK_PAGE_APP_ID`, `RELAY_PROVIDER_FACEBOOK_PAGE_APP_SECRET`, `RELAY_PROVIDER_FACEBOOK_PAGE_LOGIN_CONFIG_ID`.
- `RELAY_PROVIDER_MEDIA_URL_TTL_SECONDS` (default 3600, range 300 to 21600).
- `RELAY_PROVIDER_INSTAGRAM_INSIGHTS_ENABLED` (default false).

Expose them as `config.providers.instagram.{enabled, appId, appSecret, redirectUri, insightsEnabled}`, `config.providers.facebook_page.{...}`, `config.providers.meta.graphVersion` and `config.providers.mediaUrlTtlSeconds`. Derive redirect URIs from `publicUrl` exactly as the OIDC `redirectUri` is: `/api/connect/instagram/callback` and `/api/connect/facebook_page/callback`.

Fail-closed rules, added to the existing `problems` list:

- `RELAY_PROVIDER_INSTAGRAM_ENABLED=true` requires the app ID and secret.
- `RELAY_PROVIDER_FACEBOOK_PAGE_ENABLED=true` requires app ID, secret and config ID.
- In production the redirect must be https.

Also compute `config.providers.mediaOriginReachable`: true only when the presign endpoint (`S3_PUBLIC_ENDPOINT`, or AWS when no endpoint is set) is https and not localhost or a private address. Publishing capabilities use it in step 6. Secrets never reach the browser bundle.

**Tests:** Unit tests in env.test.ts: enabled without credentials fails; derived redirect URIs are exact; local http S3 endpoint gives `mediaOriginReachable=false`; demo mode still starts with no Meta variables.

### 2. Migration: connect attempts, publish receipts, grant scan

**Files:** `packages/db/migrations/0013_provider_connect.sql`, `packages/db/src/schema-version.ts`, `packages/db/src/generated/db.ts`, `tests/integration/tenancy.test.ts`

New file only; use the next free number if the clipping migration lands first. Then bump `REQUIRED_SCHEMA_VERSION` and run `pnpm db:types`.

**`provider_connect_attempts`** (tenant table, `relay_apply_tenant_rls`):

- `id`, `workspace_id`, `user_id`, `provider` (same 5-value CHECK), `connection_variant`, `purpose` (`connect` or `reconnect`), `social_account_id` (nullable, composite FK, for reconnect).
- `state_hash bytea UNIQUE`, `pkce_verifier_ciphertext bytea NULL`, `redirect_uri`, `requested_scopes text[]`.
- `status` (`started`, `authorized`, `completed`, `failed`).
- `pending_token_ciphertext bytea`, `pending_token_expires_at`, `candidates jsonb` (non-secret account list, `pg_column_size` cap of 16 kB).
- `expires_at`, `consumed_at`, `completed_at`, `created_at`.
- CHECK that `pending_token_ciphertext` is NULL once status is `completed` or `failed`.
- Grants: `relay_app` gets SELECT, INSERT and UPDATE on `status, consumed_at, completed_at, pending_token_ciphertext, pending_token_expires_at, candidates`. `relay_worker` gets nothing except a maintenance-scan SELECT, for cleanup of expired rows.

**`publish_provider_receipts`** (tenant table):

- `id`, `workspace_id`, `post_destination_id` (composite FK), `intent_id`, `intent_version`, `kind` (`ig_child`, `ig_parent`, `fb_video`), `position int`, `external_id text` (200 characters or fewer), `created_at`.
- `UNIQUE (post_destination_id, intent_version, kind, position)`.
- Grants: `relay_worker` SELECT, INSERT; `relay_app` SELECT.
- Reason: a carousel has up to 10 child container IDs plus a parent, which does not fit the 200-character `checkpoint_receipt_id`. The checkpoint keeps only the single current ID.

**Grant scan:** `SELECT relay_apply_maintenance_scan('provider_grants')` so the worker can find grants due for refresh. No change to the existing column grants: connect and disconnect stay in web, refresh stays in the worker.

**Tests:** `pnpm db:types:check` and `schema-version.test.ts`. Extend `tenancy.test.ts`: cross-tenant read and write of both tables fail; the worker cannot insert attempts; the app cannot insert receipts.

### 3. Provider contracts and the Meta HTTP client

**Files:** `packages/providers/src/types.ts`, `packages/providers/src/meta/http.ts`, `packages/providers/src/meta/errors.ts`, `packages/providers/src/meta/profiles.ts`, `packages/providers/src/meta/http.test.ts`, `packages/providers/src/index.ts`

**`types.ts`** — add the section 7 authorization interface:

- `AuthorizationAdapter { provider; variant; scopes; supportsPkce; buildAuthorizeUrl({state, redirectUri, codeChallenge?}); exchangeCode({code, redirectUri, codeVerifier?, signal}) -> {accessToken, expiresAt, grantedScopes, refreshToken?}; listAccounts({accessToken, signal}) -> ResolvedAccount[]; refresh?({accessToken, signal}); verify({accessToken, providerAccountId, signal}) }`.
- `ResolvedAccount` is `{providerAccountId, displayName, handle, accountType, eligible, ineligibleReason?}`, plus an opaque per-account token that never leaves the server.
- Adapter dependency types: `TokenAccessor { get(account) -> Promise<string>; reportInvalid(account, reason) }`, `ProviderMediaAccessor { url(item: IntentMediaItem, account) -> Promise<{url, expiresAt}> }`, `ReceiptStore { list(...); add(...) }`.

**`meta/http.ts`** — `createMetaClient({fetch, graphVersion})` with an injected `fetch`:

- Tokens are sent in the `Authorization` header or the form body. They go in a query string only where Meta's token endpoints require it (`ig_exchange_token`, `ig_refresh_token`, `fb_exchange_token`), and those URLs are never logged.
- Every call takes an `AbortSignal`.
- Errors carry only code, subcode, type and a truncated message.

**`meta/errors.ts`** — `classifyMetaError`:

- Code 190 means the token is invalid.
- Codes 4, 17, 32, 613 and HTTP 429 mean rate limited (honour `Retry-After`).
- Codes 10 and 200 to 299 mean permission missing.
- Code 100 means invalid parameter.
- `is_transient` or a 5xx on a GET is retryable.
- A network error or 5xx on a write is thrown, so `advancePublish` maps it to `unknown` for side-effecting phases.

**`meta/profiles.ts`** — live format profiles, with the source labelled "Meta documentation, Graph v26.0":

- Instagram video: 3 s to 15 min, 300 MB, mp4/mov.
- Instagram image: `image/jpeg` only, 8 MB, aspect 0.8 to 1.91.
- Instagram carousel: 2 to 10 items, video allowed.
- Instagram visibilities: `['public']`; caption 2200.
- Facebook Page: video only, 3 to 90 s, aspect about 9:16, mp4. No image or carousel, so those resolve to manual export.

**Tests:** Unit tests with doc-derived error payloads for every classification branch; a test that no token appears in thrown error messages or logged fields.

### 4. Token service: encrypt, decrypt, single-flight refresh, health

**Files:** `packages/services/src/provider-tokens.ts`, `packages/services/src/tasks.ts`, `packages/services/src/maintenance.ts`, `apps/worker/src/main.ts`, `packages/services/src/index.ts`, `tests/integration/provider-tokens.test.ts`

New module, the only code that touches the token columns.

- **`sealGrantToken` / `openGrantToken`**: `ctx.encryptor.encrypt/decrypt` with `secretAad({purpose: 'provider_access_token', workspaceId, provider, grantId})`.
- **`createTokenAccessor(ctx)`** implements `TokenAccessor`:
  - `get(account)` opens a short `withTenant`, loads the grant through `social_accounts.grant_id`, requires status `active` and an unexpired `access_expires_at`, and decrypts.
  - `reportInvalid` sets grant and account to `needs_reauth` with a `health_reason` (the worker has UPDATE on those columns). The next `advancePublish` claim then blocks with `connection_unhealthy`, so no state-machine change is needed.
- **`refreshGrant(ctx, {workspaceId, grantId, expectedTokenVersion}, attempt)`**, worker only:
  - Transaction 1 takes the lease with a CAS (`refresh_lease_owner`, `refresh_lease_expires_at`, `WHERE token_version = expected AND lease free or expired`).
  - The provider call runs outside any transaction with a 15-second timeout.
  - Transaction 2 writes the new ciphertext and expiry and `token_version + 1`, `WHERE token_version = expected AND refresh_lease_owner = me`.
- **Instagram refresh** (`ig_refresh_token`): only when the token is at least 24 hours old and expires within 10 days.
  - Definite refusal (190): `needs_reauth`.
  - Lost response: probe the old token with `verify` once. If it still works, keep it and retry later; if not, `needs_reauth`. No repeated rotation attempts.
- **Facebook Page tokens** have no expiry, so the same task runs `verify` (GET the Page ID) as a health check instead.
- **Tasks**: add `grant.refresh` (general pool, pointer payload `{workspaceId, grantId, tokenVersion}`) and `maintenance.refresh_grants` (hourly cron). The cron function `scanGrantsDue` lives in `maintenance.ts`: `withMaintenanceScope` to find grants, then one enqueue per grant with job key `grant.refresh:<grantId>`.
- Add a `case` for each in `handlers()` in the worker.

**Tests:** Integration tests with a fake Meta fetch:

- Ciphertext moved to another grant or workspace fails to decrypt.
- Two concurrent `refreshGrant` calls produce one provider call and one version bump.
- Refusal moves grant and account to `needs_reauth`, and a due publish then blocks with `connection_unhealthy`.
- Lost refresh response with a dead old token ends in `needs_reauth`.
- No plaintext token in the row, the job payload or captured logs.

### 5. Connect flow: services, routes, account choice

**Files:** `packages/services/src/connect.ts`, `packages/services/src/connections.ts`, `packages/providers/src/instagram/auth.ts`, `packages/domain/src/schemas.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/connections/[provider]/start/route.ts`, `apps/web/src/app/api/connect/[provider]/callback/route.ts`, `apps/web/src/app/api/v1/workspaces/[workspaceId]/connections/attempts/[attemptId]/route.ts`, `tests/integration/connect.test.ts`

Modelled on `startOidcSignIn` / `completeOidcSignIn`.

**`startProviderConnect(ctx, user, workspaceId, {provider, reconnectAccountId?}, meta)`**

- `inWorkspace` plus `authorize('connections.manage')`.
- Refuse unless the provider is enabled and an `AuthorizationAdapter` is registered.
- Insert the attempt: `state_hash = sha256(randomToken())`, 10-minute expiry, exact `redirect_uri`, requested scopes, and a PKCE verifier only when `supportsPkce`.
- Audit `connection.connect_started`.
- Return the authorize URL. The route sets an httpOnly, SameSite=Lax cookie scoped to `/api/connect` holding `workspaceId.attemptId`.

**`completeProviderCallback(ctx, user, {cookie, state, code, error})`** — the GET route is thin and outside `api()`

- Requires the signed-in session, then `inWorkspace` and `connections.manage` again (current membership).
- Atomic consume: `UPDATE ... WHERE id = attemptId AND state_hash = hash AND user_id = user AND provider = route provider AND consumed_at IS NULL AND expires_at > now RETURNING`.
- Outside the transaction: `exchangeCode` with the stored `redirect_uri`, then `listAccounts`.
- Store the token encrypted with AAD purpose `connect_pending_token` and `id = attemptId`, plus the non-secret candidates. Set status `authorized` with a 10-minute pending expiry.
- Redirect to `/w/<slug>/settings/connections?attempt=<id>`.
- Any failure marks the attempt `failed` and redirects with a reason code. The code or state is never echoed.

**`getConnectAttempt` / `finishProviderConnect(ctx, user, workspaceId, attemptId, {providerAccountIds})`** — CSRF-protected POST through `api()`

- Decrypt the pending token. For each chosen eligible account, in one transaction:
  - Insert `provider_grants` (mode `live`, the variant, granted scopes, ciphertext sealed under the new grant ID, expiry).
  - Insert `social_accounts` (`simulator_profile` NULL, real `account_type`).
  - Call `snapshotCapabilities`.
  - Audit `connection.connected` with `mode: 'live'`.
- On reconnect (the unique `(workspace, provider, provider_account_id)` row already exists), update that grant's token columns, scopes and status back to `active`. The provider account ID must equal the existing one, otherwise refuse with `account_mismatch`.
- Finally null the pending ciphertext and set status `completed`.

**Instagram authorization adapter** (`instagram/auth.ts`)

- Authorize at `https://www.instagram.com/oauth/authorize` with scopes `instagram_business_basic,instagram_business_content_publish`, `response_type=code` and state.
- Short-lived exchange at `api.instagram.com/oauth/access_token`, stripping a trailing `#_`.
- Long-lived exchange `ig_exchange_token` (60 days).
- `listAccounts` calls `GET graph.instagram.com/<version>/me?fields=user_id,username,account_type` and returns the one account, eligible only for professional types.
- No PKCE (not documented for this flow).

**Other changes**

- `disconnectAccount` additionally nulls the token ciphertext and revokes the grant for live grants when no other account shares it.
- `listConnections` replaces the hard-coded `liveConnectAvailable: false` with "provider enabled and authorization adapter registered", and returns a disabled reason otherwise.

**Tests:** Integration tests with a fake fetch:

- Happy path creates a live grant and account with ciphertext and no `simulator_profile`.
- State replay, an expired attempt, a wrong user, a wrong workspace cookie and a provider mismatch all fail without a token exchange.
- A member who lost `connections.manage` between start and callback is refused.
- A personal (non-professional) account is listed as ineligible and cannot be bound.
- A reconnect with a different Instagram user is refused.
- Disconnect clears the ciphertext.

### 6. Provider-fetch media URL and live registry wiring

**Files:** `packages/services/src/assets.ts`, `packages/services/src/context.ts`, `packages/services/src/connections.ts`, `packages/services/src/publish-receipts.ts`, `packages/providers/src/catalog.ts`, `tests/integration/provider-media.test.ts`

**`providerMediaUrl(ctx, {workspaceId, assetId, assetVersion, sha256})`** in `assets.ts`

- Worker role only (throws otherwise).
- Inside `withTenant`, load the asset and require status `ready` and that version and hash equal the intent's `IntentMediaItem`.
- Call `ctx.storage.presignGet({key, versionId, contentType, expiresInSeconds: config.providers.mediaUrlTtlSeconds})`. This is a SigV4 capability URL for one immutable object version: no listing, the bucket stays private, and no auth header is needed.
- Before returning, assert the URL is https and its host equals the configured presign host. Otherwise throw `MediaOriginError`; the adapter turns it into `rejected` with code `media_origin_unreachable`.
- Log only `{assetId, assetVersion, expiresAt}`. Return the URL only to the adapter; it is never stored.
- Rights and media readiness are already re-checked by `advancePublish` transaction A before every step.

**`createServiceContext`**

- Build the `live` map for `createAdapterRegistry` when `config.providers[id].enabled` and credentials are present.
- Web and worker both register the adapter, so `adapterCapabilities` works for live accounts in web. Its `capabilities()` is network-free: profile from `meta/profiles.ts`, `requiredScopes`, and `accountTypeSupported` from `account.accountType`.
- Only the worker's dependencies can mint media URLs or write receipts.

**`publish-receipts.ts`**: `ReceiptStore` over `publish_provider_receipts`.

**`evaluateCapabilities`**: for live accounts on pull-based providers, `deploymentEnabled` becomes `enabled && config.providers.mediaOriginReachable`, so a local stack shows publishing as disabled and manual export instead of failing at dispatch.

**`catalog.ts`**: change `PROVIDER_CATALOG.instagram.live.status` to an "implemented, not live-verified" value only when this step's code lands. It never reads "live-verified" from code alone.

**Tests:** Integration tests:

- The URL fetches exactly the pinned version after a newer version is uploaded.
- A wrong hash or a non-ready asset is refused.
- The app role is refused.
- The URL is absent from logs and audit rows.
- With `demoMode=true`, a live account with no adapter still resolves to null.
- With an http or localhost storage endpoint, the live publish capability is disabled.

### 7. Instagram publishing adapter (image, Reel, carousel)

**Files:** `packages/providers/src/instagram/publishing.ts`, `packages/providers/src/instagram/publishing.test.ts`, `packages/providers/src/instagram/fixtures/`, `tests/integration/instagram-publish.test.ts`

`createInstagramPublishingAdapter({client, clock, tokens, media, receipts, pollIntervalMs})` implements `PublishingAdapter` with `mode: 'live'`. `initialPhase()` is `prepare`. `mayRunBeforePlannedTime` is false for all phases.

**prepare** (not side-effecting)

- `GET /me` must return `account.providerAccountId`; otherwise `rejected` with `account_mismatch`.
- `GET /<ig-id>/content_publishing_limit?fields=quota_usage,config`; if exhausted, return `rate_limited`.
- Continue to `transfer`.

**transfer** (side-effecting, one write per call)

- Mint the URL for the next item and `POST /<ig-id>/media`:
  - Image: `image_url`, `caption`, `alt_text`.
  - Reel: `media_type=REELS`, `video_url`, `caption`, `share_to_feed`.
  - Carousel child: `is_carousel_item=true` (`media_type=VIDEO` for video).
- Record each ID through `receipts.add`. Return `continue` with phase `transfer` until all children exist.
- For a carousel, poll the children. If any is `IN_PROGRESS`, return `waiting`. When all are `FINISHED`, create the parent (`media_type=CAROUSEL`, `children`, `caption`).
- Set `receiptId` to the container to publish and continue to `wait_processing`.

**wait_processing** (not side-effecting)

- `GET /<container>?fields=status_code`.
- `IN_PROGRESS`: `waiting` with `nextCheckAt = now + 60 s`, capped by a total budget.
- `FINISHED`: continue to `dispatch`.
- `ERROR`: `rejected` with `ig_container_error`.
- `EXPIRED`: continue back to `transfer` with the receipt cleared.

**dispatch** (side-effecting; never before `plannedAt`, which `advancePublish` enforces)

- Re-read `status_code` first.
- Then `POST /<ig-id>/media_publish` with `creation_id`. Return `continue` to `confirm` with `providerPostId`.

**confirm** (not side-effecting)

- `GET /<media-id>?fields=id,permalink,timestamp`, then `confirmed` with `containerId`, `permalink`, `publishedAt` and visibility `public`.

**Error mapping**

- 190: `tokens.reportInvalid`, then `retryable` (a definite refusal, no effect).
- Rate codes: `rate_limited`.
- Permission or invalid parameter: `rejected`.
- A timeout or network error on a write is thrown, so the state machine records `unknown`.

**reconcile** (own 20-second timeout)

- Checkpoint phase `transfer`: return `processing` with phase `transfer`. No publish call can have been made, and stored receipts prevent duplicate children.
- Checkpoint phase `dispatch` with a saved container ID, by lookup on that ID:
  - `FINISHED`: `not_found` (proof by ID lookup).
  - `EXPIRED` or `ERROR`: `not_found`.
  - `PUBLISHED`: the media ID is not returned by the container, so return `indeterminate` with reason `published_media_id_unknown`; the operator links it through `resolveReconciliation`. Never match by caption or time.
- Checkpoint phase `confirm` with `providerPostId`: read the media; return `published`, or `processing` with phase `confirm`.

`validate` reuses the profile rules and adds the JPEG-only and 2-to-10-item checks.

**Tests:** Unit contract tests against JSON fixtures. Until the operator's run, fixtures are hand-written from the documentation and named `doc-derived`; they are replaced by sanitized recordings afterwards.

- Each phase for image, Reel and a mixed carousel.
- `ERROR` and `EXPIRED` containers, quota exhausted, 190, 429 with `Retry-After`, account mismatch.

Integration tests through `advancePublish` / `reconcilePublish` with a scripted fake Meta:

- End to end for the three formats, with one `external_publications` row stamped `mode: live`.
- Crash or timeout on `media_publish`, then container `FINISHED`: resumes and publishes exactly once.
- Timeout, then `PUBLISHED`: stays in `needs_reconciliation` until the operator links it.
- Timeout during a carousel child: no duplicate child.
- A pause before dispatch sends no publish call.

### 8. Connections UI: live connect, chooser, reconnect

**Files:** `apps/web/src/components/settings/ConnectionForms.tsx`, `apps/web/src/app/w/[slug]/settings/connections/page.tsx`, `tests/e2e/`

Driven by the `providers[]` list from `listConnections`.

- A "Connect Instagram" / "Connect Facebook Page" button appears only when live connect is available. It POSTs to the start route and navigates to the returned URL. When unavailable, show the disabled reason (flag off, credentials missing, media origin not reachable).
- When the page loads with `?attempt=`, show the account chooser from `getConnectAttempt`:
  - Instagram shows the single account for confirmation.
  - Facebook shows a checklist of Pages, with ineligible ones greyed out and the reason given.
- A "Reconnect" action for accounts in `needs_reauth`.
- Every row carries a "Live" or "Simulated" badge. Live Meta rows add "Test accounts only until Meta app review" and "Not yet verified on staging" until `docs/implementation-status.md` records a real run.
- Per-format capability chips reuse the existing capability output.
- Keep the page light: no new client data fetching beyond the attempt lookup.

**Tests:** Playwright against the fake provider (CI has no Meta credentials): the connect button is absent when the flag is off; the chooser binds the account; simulated and live badges are distinguishable; keyboard flow works. Component states for the disabled reasons.

### 9. Facebook Page connect (distinct variant and token type)

**Files:** `packages/providers/src/facebook-page/auth.ts`, `packages/services/src/connect.ts`, `packages/providers/src/facebook-page/fixtures/`, `tests/integration/connect.test.ts`

`createFacebookPageAuthorization` implements `AuthorizationAdapter`.

- Dialog: `https://www.facebook.com/<version>/dialog/oauth` with `client_id`, `redirect_uri`, `state`, `config_id`, `response_type=code`. No `scope` parameter; the Login for Business configuration carries `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
- Code exchange, then `fb_exchange_token` for a long-lived user token.
- `listAccounts`: `GET /me/accounts?fields=id,name,category,tasks,access_token`. A Page is eligible only if `tasks` includes content creation.
- The user's personal profile is never returned as a candidate, and no code path can bind a non-Page ID.
- `finishProviderConnect` creates one grant per chosen Page, holding that Page's token sealed under its own grant ID, with `access_expires_at` NULL and `account_type='page'`. Removing one Page therefore never affects another.
- The user token lives only in the pending attempt and is deleted on completion.
- Granted scopes come from `GET /me/permissions`.
- Instagram and Facebook grants differ in `provider` and `connection_variant`. The token accessor loads by the account's own grant, so a Page token can never be used for an Instagram call.

**Tests:** Integration tests with a fake fetch: several Pages, one lacking the content task (ineligible); two Pages give two grants; disconnecting one leaves the other working; a missing `pages_manage_posts` gives capability `missing_scope`; no personal-profile candidate; the pending user token is gone after completion.

### 10. Facebook Page Reels adapter

**Files:** `packages/providers/src/facebook-page/publishing.ts`, `packages/providers/src/facebook-page/publishing.test.ts`, `tests/integration/facebook-publish.test.ts`, `packages/services/src/context.ts`

`createFacebookPagePublishingAdapter` takes the same dependencies as the Instagram adapter. Video only; image and carousel are absent from the profile, so they resolve to manual export.

- **prepare**: `GET /<page-id>?fields=id` with the Page token must return the bound Page.
- **transfer** (side-effecting, two calls across two `advance` steps):
  1. `POST /<page-id>/video_reels` with `upload_phase=start`. Save `video_id` as `receiptId` and in the receipt store before anything else.
  2. `POST https://rupload.facebook.com/video-upload/<version>/<video_id>` with `Authorization: OAuth <page token>` and a `file_url` header carrying the provider media URL (Meta pulls the file; no bytes pass through the worker).
- **wait_processing**: `GET /<video_id>?fields=status` until the upload phase is complete. Error states give `rejected`.
- **dispatch** (side-effecting): `POST /<page-id>/video_reels` with `upload_phase=finish`, `video_id`, `video_state=PUBLISHED`, `description`. An HTTP success is not treated as published.
- **confirm**: poll status until the publishing phase is complete and published, then `confirmed` with `providerPostId = video_id`.

**reconcile**, always by the saved `video_id`:

- Publishing phase not started: `not_found`.
- In progress: `processing` with phase `confirm`.
- Complete and published: `published`.
- No saved `video_id` (lost response on start): `processing` with phase `transfer`; nothing public can exist.

Register under `live.facebook_page` in `createServiceContext`.

**Tests:** Unit contract tests on doc-derived fixtures for start, upload, finish and each status combination. Integration tests: end to end; a lost finish response followed by a published status reconciles to `published` without a second finish; a lost finish response followed by "not started" resumes and finishes once; an image post to a Page resolves to manual export, not an API attempt.

### 11. Insights, gated on confirmation

**Files:** `packages/providers/src/instagram/metrics.ts`, `packages/services/src/context.ts`, `packages/db/migrations/0014_meta_metric_definitions.sql`

Not registered by default. `registry.metrics('instagram', 'live')` returns null, so `refreshMetrics` records `adapter_unavailable` and Results shows "not available", never simulated numbers.

Implement `MetricsAdapter.fetchPostMetrics` only after the operator's run confirms the insights scope (believed to be `instagram_business_manage_insights`) and the media insights endpoint and metric names for the pinned Graph version. Then:

- Add the scope as a separate incremental capability (`metrics.read` in `requiredScopes`).
- Add versioned metric definitions in a new migration.
- Set a real `sourcePolicy`.
- Register only when `RELAY_PROVIDER_INSTAGRAM_INSIGHTS_ENABLED=true`.
- Metrics the API does not return are recorded as unavailable, not zero.

Facebook Page insights are deferred the same way.

**Tests:** Before confirmation: an integration test that a live publication yields `adapter_unavailable` and no synthetic readings. After confirmation: contract tests on recorded sanitized insight payloads, including a metric missing from the response.

### 12. Documentation, fixture recording and status

**Files:** `docs/providers/instagram.md`, `docs/providers/facebook-pages.md`, `docs/providers/matrix.md`, `docs/implementation-status.md`, `docs/runbooks/vercel-staging.md`, `docs/worker-tasks.md`, `docs/security-model.md`

Write the two provider documents required by spec section 8: setup screens, products, exact callback URI, app mode, scopes, token lifetime and refresh, format matrix, limits, review status, policy links, and the staging smoke steps listed under operator actions.

Add a capture option to the Meta client, used only in the operator's staging run, that writes responses to a directory with tokens, IDs, usernames and signed URLs replaced. Those files replace the doc-derived fixtures.

Update `matrix.md` and `implementation-status.md` with three separate columns per capability:

- Real adapter (code present).
- Contract-tested, stating whether fixtures are doc-derived or recorded.
- Live-verified: stays "No" until the operator reports a real run, with date and Graph version.

Also document the new tasks and cron in `worker-tasks.md`, and the token and media-URL handling in `security-model.md`.

**Tests:** `pnpm lint` (including the invisible-Unicode source check), `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e` all pass with no Meta credentials present.

## Migrations

- 0013_provider_connect.sql (new file; use the next free number if the clipping migration takes 0013): creates `provider_connect_attempts` and `publish_provider_receipts` with tenant RLS and explicit per-role grants, and adds `relay_apply_maintenance_scan('provider_grants')`. Bump `REQUIRED_SCHEMA_VERSION` and run `pnpm db:types`.
- 0014_meta_metric_definitions.sql (only with step 11, after insights are confirmed on a real run): live Instagram metric definition versions.
- No edits to 0001-0012. Existing `provider_grants` token, expiry, `token_version` and lease columns and their column grants are used as they are.
- Applying these to the hosted staging or any shared database is an operator action (`pnpm db:migrate`, or the staging worker's auto-migrate).

## Operator actions

- Meta app: at developers.facebook.com create a Business-type app under your Meta business portfolio. One app can serve both adapters; use a separate app per environment (staging, production).
- Instagram product: add the Instagram product and choose "API setup with Instagram login". Copy the Instagram app ID and Instagram app secret from that page (not the Meta app ID).
- Instagram redirect: under Business login settings add exactly `https://<staging-host>/api/connect/instagram/callback` as the OAuth redirect URI. Check whether the dashboard appends a trailing slash and report it.
- Instagram permissions: enable `instagram_business_basic` and `instagram_business_content_publish` on the app. Standard Access is enough for accounts with a role on the app.
- Instagram test account: use a professional (Business or Creator) account that is public. Add it under App roles > Roles as an Instagram Tester, then accept the invite in Instagram under Settings > Apps and websites > Tester invites.
- Facebook product: add Facebook Login for Business. Add `https://<staging-host>/api/connect/facebook_page/callback` under Valid OAuth Redirect URIs.
- Facebook configuration: create a Login for Business configuration with a User access token and the permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. Copy its configuration ID.
- Facebook test Page: create or pick a test Page. The Facebook user who connects must have a role on the app (admin, developer or tester) and be able to create content on that Page.
- Environment variables, set on both the web host and the worker host: `RELAY_PROVIDER_INSTAGRAM_ENABLED=true`, `RELAY_PROVIDER_INSTAGRAM_APP_ID`, `RELAY_PROVIDER_INSTAGRAM_APP_SECRET`, `RELAY_PROVIDER_FACEBOOK_PAGE_ENABLED=true`, `RELAY_PROVIDER_FACEBOOK_PAGE_APP_ID`, `RELAY_PROVIDER_FACEBOOK_PAGE_APP_SECRET`, `RELAY_PROVIDER_FACEBOOK_PAGE_LOGIN_CONFIG_ID`, `RELAY_META_GRAPH_VERSION=v26.0`, optionally `RELAY_PROVIDER_MEDIA_URL_TTL_SECONDS`. Leave `RELAY_PROVIDER_INSTAGRAM_INSIGHTS_ENABLED` unset.
- Staging prerequisites: finish the hosted staging deployment (web, worker, database, bucket) from `docs/runbooks/vercel-staging.md`. `RELAY_PUBLIC_URL` must be the https staging host, and the bucket must be on an https endpoint Meta can reach (AWS S3 or equivalent). The bucket stays private.
- Apply the new migration on staging (worker auto-migrate or `pnpm db:migrate`).
- Staging smoke run, each step reported back with date and result: (1) connect the Instagram test account; (2) publish one JPEG image; (3) publish one 9:16 H.264/AAC MP4 Reel; (4) publish one carousel with an image and a video; (5) stop the worker during a publish and confirm the post appears exactly once or lands in reconciliation; (6) wait 24 hours and confirm the token refresh succeeds; (7) connect the test Page and publish one Reel; (8) remove the app in Instagram settings and confirm the account shows "needs reconnect". Capture sanitized fixtures during this run.
- Confirm from the live Meta docs and the run: the publishing host for Instagram Login tokens, Creator account eligibility, the caption limit, the publish quota (50 or 100), and the insights scope and endpoint. Insights stay off until confirmed.
- Before serving accounts that have no role on the app: complete Business Verification and App Review for Advanced Access (screencast of login plus publishing), provide privacy policy, data deletion and deauthorize URLs, and switch the app to Live mode.
- Before production: provision the KMS key and IAM policy (M3). Production start-up remains blocked without the KMS key provider.
- Optional: allow developers.facebook.com in this environment's network settings so the endpoints can be checked against the full documentation before coding.

## Risks

- Meta documentation was not readable here; hosts, parameters and limits come from search summaries. Wrong details (for example the publishing host or whether `Authorization` headers are accepted on graph.instagram.com) will surface only in the staging run.
- A lost response on `media_publish` where the container later reads `PUBLISHED` cannot be auto-resolved, because the container does not return the media ID. The post stays in `needs_reconciliation` until an operator links the ID. This is the safe behaviour but needs a person.
- Meta must be able to fetch a presigned S3 URL with query-string signing and no redirect. If it cannot, the fallback is a dedicated media origin (CDN with signed URLs) or the resumable upload path for video, which is extra work.
- Instagram accepts JPEG images only. PNG or WebP uploads will fail validation for Instagram until a JPEG rendition step is added (not in this plan).
- Reels must be H.264 or HEVC with AAC and the moov atom at the front. Relay does not validate codecs per destination today; a bad file is rejected by Meta at processing time, not at approval time. The clip renderer (M2) should output a compliant preset.
- No work is pre-staged before the due time, so Reels go live some minutes after the planned time while Meta processes them.
- Provider-wide rate budgets and circuit breakers are not modelled. v1 relies on the per-account `content_publishing_limit` check and Meta's rate-limit responses. Repeated quota waits count toward the retry cap in `advancePublish` and can end in a failed destination.
- Refresh must run at least once in each token's 60-day life. If the worker is down for long or the refresh job fails silently, accounts drop to `needs_reauth` and scheduled posts block.
- Live tokens on staging are protected by the local keyring from environment variables, not KMS. Acceptable for a test account; not for customer accounts.
- Two plans (clipping and Meta) both want the next migration number; they must be sequenced to keep numbering gapless.
- Without App Review only accounts with a role on the app can connect. The product is usable for the owner's own accounts but not for third-party customers until review passes.
- On reconnect, whether to bump `connection_generation` needs a check of how `advancePublish` compares it; bumping it would block already scheduled posts for that account.

## Cannot be verified in the development environment

- Any real call to Meta: OAuth login, token exchange, refresh, container creation, publishing, Page Reels. No Meta app, credentials or test account exist in this environment, and developers.facebook.com is blocked.
- That Meta can fetch the presigned media URL. The local object store is not reachable from Meta; this needs hosted staging with an https bucket endpoint.
- Fixture accuracy. Fixtures written here are derived from documentation summaries, not recorded. Contract tests on them prove Relay's handling of the assumed shapes, not Meta's actual responses.
- Items the docs summary marked unverified: `#_` suffix on the code, short-lived token response shape, graph.instagram.com as the publishing host, Creator eligibility, status polling cadence, image size and aspect limits, caption limit, publish quota of 50 versus 100, tester invite flow, Facebook dialog URL and PKCE support, `upload_phase` casing, and whether the rupload call with `file_url` returns before the fetch completes.
- Whether the old Instagram token stays valid after a refresh whose response was lost.
- Insights scope, endpoint and metric names for Instagram Login on the pinned Graph version.
- Token refresh after the 24-hour minimum age, and 60-day expiry behaviour, which need elapsed real time.
- App Review, Business Verification and Live-mode behaviour for accounts without a role on the app.
- What can be tested here with fixtures only: config rules, the migration and RLS, token encryption and single-flight refresh, the full connect flow against a fake provider, media URL minting against the local store, every adapter phase and reconcile branch, the state-machine paths (crash, timeout, retry, pause, reconciliation), capability gating, the no-simulator-fallback rule, and the UI flows.
