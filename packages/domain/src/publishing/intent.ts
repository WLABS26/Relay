import type { ConnectionMode, DestinationProviderId, Visibility } from '../providers';

/**
 * The normalised publish intent for one destination: everything that determines what the
 * platform will receive. Approvals bind to the hash of this structure (see server.ts), so any
 * change to media, copy, visibility, metadata, declarations, target account or rights
 * invalidates the approval for exactly the destinations it affects.
 */
export interface PublishIntentPayload {
  workspaceId: string;
  postId: string;
  destination: {
    pageDestinationId: string;
    socialAccountId: string;
    provider: DestinationProviderId;
    connectionMode: ConnectionMode;
    providerAccountId: string;
  };
  media: Array<{
    position: number;
    assetId: string;
    assetVersion: number;
    kind: 'video' | 'image';
    sha256: string | null;
  }>;
  caption: string;
  title: string | null;
  visibility: Visibility;
  metadata: Record<string, string | number | boolean | null>;
  declarations: CreatorDeclarations;
  rights: Array<{ assetId: string; grantId: string; grantVersion: number }>;
}

/** Creator/operator declarations carried verbatim to providers that support them. */
export interface CreatorDeclarations {
  /** Content includes a paid partnership or sponsorship. */
  paidPartnership: boolean;
  /** Content contains realistic altered or synthetic media. */
  alteredOrSyntheticMedia: boolean;
  /** Audience declaration where a platform requires it (e.g. made for kids); null = not set. */
  madeForKids: boolean | null;
}

export const DEFAULT_DECLARATIONS: CreatorDeclarations = {
  paidPartnership: false,
  alteredOrSyntheticMedia: false,
  madeForKids: null,
};

/** Normalise user text: Unicode NFC and LF line endings. Everything else is content. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

/**
 * Deterministic JSON: object keys sorted, undefined properties dropped, no whitespace. Used for
 * hashing intents, idempotency request fingerprints and operation keys. Values JSON cannot
 * represent faithfully (functions, symbols, bigints) are refused rather than silently
 * dropped, because two different inputs must never hash alike.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`canonicalJson cannot encode a ${typeof value}`);
  }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/** Stable publish operation key: workspace, destination, revision and intent version. */
export function publishOperationKey(parts: {
  workspaceId: string;
  postDestinationId: string;
  revisionId: string;
  intentVersion: number;
}): string {
  return `${parts.workspaceId}:${parts.postDestinationId}:${parts.revisionId}:${parts.intentVersion}`;
}
