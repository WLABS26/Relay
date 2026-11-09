import type { DestinationFormatProfile, DestinationProviderId, ProviderId } from '@relay/domain';

/**
 * Provider catalogue: what Relay implements per provider and connection mode, and the format
 * profiles used by the simulator. Simulator profiles are plausible demo values, NOT verified
 * platform limits; real limits are recorded in docs/providers/<provider>.md when each live
 * adapter is implemented and contract-tested.
 */

export type ImplementationStatus = 'implemented' | 'planned';

export interface ProviderCatalogEntry {
  id: ProviderId;
  label: string;
  roles: Array<'destination' | 'source'>;
  live: { status: ImplementationStatus; milestone: string; notes: string };
  simulated: { status: ImplementationStatus };
  docs: string;
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderCatalogEntry> = {
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    roles: ['destination', 'source'],
    live: { status: 'planned', milestone: 'M3', notes: 'OAuth, resumable videos.insert, processing status, Analytics.' },
    simulated: { status: 'implemented' },
    docs: 'docs/providers/youtube.md',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    roles: ['destination'],
    live: { status: 'planned', milestone: 'M4', notes: 'Instagram Login, media containers, Reels and carousels.' },
    simulated: { status: 'implemented' },
    docs: 'docs/providers/instagram.md',
  },
  facebook_page: {
    id: 'facebook_page',
    label: 'Facebook Page',
    roles: ['destination'],
    live: { status: 'planned', milestone: 'M4', notes: 'Page-scoped token, video_reels start/upload/finish.' },
    simulated: { status: 'implemented' },
    docs: 'docs/providers/facebook-pages.md',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    roles: ['destination'],
    live: { status: 'planned', milestone: 'M5', notes: 'Manual export first; audited Direct Post only when eligible.' },
    simulated: { status: 'implemented' },
    docs: 'docs/providers/tiktok.md',
  },
  twitch: {
    id: 'twitch',
    label: 'Twitch',
    roles: ['source'],
    live: { status: 'planned', milestone: 'M5', notes: 'Creator-approved source: Helix, EventSub, native clips.' },
    simulated: { status: 'planned' },
    docs: 'docs/providers/twitch.md',
  },
};

const SIM = 'Simulator profile (demo values, not a verified platform limit)';
const GiB = 1024 ** 3;

export const SIMULATOR_FORMAT_PROFILES: Record<DestinationProviderId, DestinationFormatProfile> = {
  youtube: {
    source: SIM,
    publishMode: 'api',
    video: { minDurationMs: 1000, maxDurationMs: 12 * 3600 * 1000, maxBytes: 128 * GiB, aspect: { min: 0.2, max: 5 }, containers: ['mp4', 'mov', 'webm'] },
    visibilities: ['public', 'unlisted', 'private'],
    captionMaxLength: 5000,
    title: { required: true, maxLength: 100 },
  },
  instagram: {
    source: SIM,
    publishMode: 'api',
    video: { minDurationMs: 3000, maxDurationMs: 15 * 60 * 1000, maxBytes: GiB, aspect: { min: 0.5, max: 1.91 }, containers: ['mp4', 'mov'] },
    image: { maxBytes: 8 * 1024 ** 2, aspect: { min: 0.8, max: 1.91 }, mimes: ['image/jpeg', 'image/png'] },
    carousel: { minItems: 2, maxItems: 10, allowVideo: true },
    visibilities: ['public'],
    captionMaxLength: 2200,
  },
  facebook_page: {
    source: SIM,
    publishMode: 'api',
    video: { minDurationMs: 3000, maxDurationMs: 90 * 1000, maxBytes: GiB, aspect: { min: 0.5, max: 0.6 }, containers: ['mp4', 'mov'] },
    image: { maxBytes: 10 * 1024 ** 2, aspect: { min: 0.5, max: 2 }, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
    visibilities: ['public'],
    captionMaxLength: 5000,
  },
  tiktok: {
    source: SIM,
    // Manual export first: Relay prepares the file; posting happens in TikTok.
    publishMode: 'manual_export',
    video: { minDurationMs: 3000, maxDurationMs: 10 * 60 * 1000, maxBytes: 4 * GiB, aspect: { min: 0.5, max: 1.0 }, containers: ['mp4', 'mov', 'webm'] },
    visibilities: ['public', 'followers', 'private'],
    captionMaxLength: 2200,
  },
};

/** Simulated account types per provider (mirrors the kind of account a real adapter targets). */
export const SIMULATED_ACCOUNT_TYPES: Record<DestinationProviderId, string> = {
  youtube: 'channel',
  instagram: 'professional',
  facebook_page: 'page',
  tiktok: 'creator',
};
