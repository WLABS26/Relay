/** Provider identifiers and shared enums. Platform-specific limits live in provider profiles. */

export const PROVIDERS = ['youtube', 'instagram', 'facebook_page', 'tiktok', 'twitch'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Providers that can be publishing destinations. Twitch is a source only. */
export const DESTINATION_PROVIDERS = ['youtube', 'instagram', 'facebook_page', 'tiktok'] as const;
export type DestinationProviderId = (typeof DESTINATION_PROVIDERS)[number];

/**
 * `simulated` connections are driven by Relay's deterministic provider simulator. They are
 * only usable when demo mode is on and are labelled as simulated everywhere. `live`
 * connections use a real adapter and never fall back to the simulator.
 */
export const CONNECTION_MODES = ['simulated', 'live'] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

export const VISIBILITIES = ['public', 'unlisted', 'private', 'followers'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook_page: 'Facebook Page',
  tiktok: 'TikTok',
  twitch: 'Twitch',
};

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: 'Public',
  unlisted: 'Unlisted',
  private: 'Private',
  followers: 'Followers only',
};

export const PAGE_GOALS = ['views', 'watch_time', 'followers', 'conversions', 'revenue'] as const;
export type PageGoal = (typeof PAGE_GOALS)[number];

export const PAGE_GOAL_LABELS: Record<PageGoal, string> = {
  views: 'Views',
  watch_time: 'Qualified watch time',
  followers: 'Follower growth',
  conversions: 'Conversions',
  revenue: 'Recorded revenue',
};

export const CONTENT_FORMATS = ['video', 'image', 'carousel'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export function isDestinationProvider(value: string): value is DestinationProviderId {
  return (DESTINATION_PROVIDERS as readonly string[]).includes(value);
}
