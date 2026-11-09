# Provider matrix

Spec §8 and §14. Each capability moves through separate states, tracked independently:

1. **Simulated:** the deterministic simulator models it (demo mode only).
2. **Implemented:** a real adapter exists and passes contract tests against sanitized fixtures.
3. **Live-verified:** an authorized smoke test against a test account succeeded.

As of 2026-11-09 **nothing is implemented or live-verified**. M0/M1 use only simulated connections.

## Documentation verification

The spec's research baseline is 9 November 2026. **Provider documentation was not re-checked for
this build** because no adapter, endpoint version or scope was chosen in M0/M1. Each adapter
milestone must verify the primary references below on the day it starts, record the date
checked here, and record discrepancies instead of guessing.

| Provider       | Primary references (spec §14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Checked      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| YouTube        | [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) · [Video resource](https://developers.google.com/youtube/v3/docs/videos) · [Resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) · [Revision history](https://developers.google.com/youtube/data/revision_history) · [Analytics reports](https://developers.google.com/youtube/analytics/reference/reports/query) · [Developer policies](https://developers.google.com/youtube/terms/developer-policies) · [Derived metrics policy](https://developers.google.com/youtube/terms/derived-metrics-policy) | Not yet (M3) |
| Instagram      | [Content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing) · [Meta Instagram collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)                                                                                                                                                                                                                                                                                                                                                                                       | Not yet (M4) |
| Facebook Pages | [Facebook Reels collection](https://www.postman.com/meta/facebook/request/rgkn91u/1-create-reel)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Not yet (M4) |
| TikTok         | [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) · [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post) · [Upload](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video) · [Status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status)                                                                                                                                                                                                                                       | Not yet (M5) |
| Twitch         | [Helix reference](https://dev.twitch.tv/docs/api/reference/) · [EventSub webhooks](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Not yet (M5) |

## Capabilities by destination

| Destination            | Capability                            | Simulated                | Implemented | Live-verified | Gate / approval needed                                                                           |
| ---------------------- | ------------------------------------- | ------------------------ | ----------- | ------------- | ------------------------------------------------------------------------------------------------ |
| YouTube channel        | Video upload with explicit visibility | Yes                      | No          | No            | OAuth client, consent verification, quota; private visibility until authorized live verification |
| YouTube channel        | Scheduled publish (private → public)  | Relay-side schedule only | No          | No            | Same                                                                                             |
| YouTube channel        | Metrics (owner-visible, raw)          | Synthetic                | No          | No            | Derived-metrics policy review before any derivation                                              |
| Instagram professional | Image, Reel, carousel                 | Yes                      | No          | No            | Meta app review (content publishing), professional account                                       |
| Facebook Page          | Page-scoped Reels/photos              | Yes                      | No          | No            | Meta app review (Pages permissions); never a personal profile                                    |
| TikTok                 | Manual export                         | Planned                  | No          | No            | None (user posts in the app)                                                                     |
| TikTok                 | Direct post                           | Yes (demo only)          | No          | No            | Content Posting API audit; exact consent UX                                                      |
| Twitch                 | Source and clips (not a destination)  | No                       | No          | No            | App registration, EventSub secret (M5)                                                           |

## Simulator profiles

Configured per simulated connection (`Settings → Connections`). Format rules come from a
simulator profile per provider and are labelled "Simulator profile (not a platform limit)".

| Profile             | Behaviour                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `reliable`          | Prepares a private container, dispatches once, confirms with the intended visibility        |
| `slow_processing`   | Two processing polls with a next-check time before dispatch                                 |
| `rate_limited_once` | First dispatch returns 429 with Retry-After                                                 |
| `transient_then_ok` | First transfer returns a retryable 503                                                      |
| `lost_response`     | Post goes live but the response is lost; reconciliation proves it (exactly one remote post) |
| `ambiguous`         | Like `lost_response`, but lookup is impossible: an operator must decide                     |
| `reject_format`     | Dispatch is permanently rejected                                                            |

## Discrepancies

None recorded yet; adapters will add rows here.
