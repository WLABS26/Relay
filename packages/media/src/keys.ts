import { isUuid } from '@relay/domain';

/**
 * Server-generated object keys. Clients never choose keys; every key is scoped by workspace,
 * asset and version so a key can be authorised by parsing it and a late write cannot replace
 * another asset's bytes.
 */

const EXT_RE = /^[a-z0-9]{1,8}$/;

function assertScope(workspaceId: string, assetId: string, version: number): void {
  if (!isUuid(workspaceId) || !isUuid(assetId))
    throw new Error('object keys require UUID workspace and asset IDs');
  if (!Number.isInteger(version) || version < 1)
    throw new Error('version must be a positive integer');
}

export function assetOriginalKey(
  workspaceId: string,
  assetId: string,
  version: number,
  extension: string,
): string {
  assertScope(workspaceId, assetId, version);
  const ext = EXT_RE.test(extension) ? extension : 'bin';
  return `ws/${workspaceId}/assets/${assetId}/v${version}/original.${ext}`;
}

export function assetVariantKey(
  workspaceId: string,
  assetId: string,
  version: number,
  kind: 'thumbnail' | 'poster' | 'proxy',
  profile: string,
  extension: string,
): string {
  assertScope(workspaceId, assetId, version);
  if (!/^[a-z0-9-]{1,40}$/.test(profile)) throw new Error('invalid variant profile');
  return `ws/${workspaceId}/assets/${assetId}/v${version}/variants/${kind}-${profile}.${EXT_RE.test(extension) ? extension : 'bin'}`;
}

/** Workspace that owns a key, or null for keys outside the tenant layout. */
export function workspaceOfKey(key: string): string | null {
  const m = /^ws\/([0-9a-f-]{36})\//.exec(key);
  return m && isUuid(m[1]) ? m[1]! : null;
}
