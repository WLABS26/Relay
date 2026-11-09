/**
 * Effective capability = intersection of: implementation, deployment enablement, provider
 * program approval, granted scopes, account type, requested format and visibility, policy
 * rules and the latest runtime provider response. The first failing check decides the
 * user-facing state and reason, and a fallback is offered where one exists. The worker calls
 * the same function as the HTTP layer before every dispatch.
 */

export type CapabilityState =
  'enabled' | 'disabled' | 'missing_scope' | 'needs_review' | 'not_supported';

export type CapabilityFallback = 'manual_export' | 'reconnect' | null;

export interface Capability {
  state: CapabilityState;
  reasonCode?: string;
  message: string;
  fallback: CapabilityFallback;
  checkedAt: string;
}

export const CAPABILITY_KEYS = [
  'publish.video',
  'publish.image',
  'publish.carousel',
  'metrics.read',
  'export.manual',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface CapabilityInputs {
  /** A real adapter (live) or the simulator (simulated) implements this capability. */
  implemented: boolean;
  connectionMode: 'simulated' | 'live';
  demoMode: boolean;
  /** Deployment feature flag for this provider/capability. */
  deploymentEnabled: boolean;
  programApproval: 'not_required' | 'approved' | 'pending' | 'denied';
  requiredScopes: readonly string[];
  grantedScopes: readonly string[];
  accountTypeSupported: boolean;
  formatSupported: boolean;
  visibilitySupported: boolean;
  policyAllows: boolean;
  runtimeHealth: 'healthy' | 'needs_reauth' | 'revoked' | 'degraded' | 'unknown';
  /** Provider-specific publish mode: some destinations only support manual export. */
  publishMode?: 'api' | 'manual_export';
}

export function resolveCapability(inputs: CapabilityInputs, now: Date): Capability {
  const checkedAt = now.toISOString();
  const result = (
    state: CapabilityState,
    reasonCode: string | undefined,
    message: string,
    fallback: CapabilityFallback = null,
  ): Capability =>
    reasonCode
      ? { state, reasonCode, message, fallback, checkedAt }
      : { state, message, fallback, checkedAt };

  if (inputs.connectionMode === 'simulated' && !inputs.demoMode) {
    return result(
      'disabled',
      'simulator_disabled',
      'Simulated connections are disabled in this deployment.',
    );
  }
  if (!inputs.implemented) {
    return result(
      'not_supported',
      'adapter_not_implemented',
      'Relay does not support this yet for this platform. Export the file and post it manually.',
      'manual_export',
    );
  }
  if (inputs.publishMode === 'manual_export') {
    return result(
      'not_supported',
      'manual_export_only',
      'This destination is set up for manual export: Relay prepares the file and you post it in the app.',
      'manual_export',
    );
  }
  if (!inputs.deploymentEnabled) {
    return result(
      'disabled',
      'deployment_disabled',
      'An administrator has not enabled this integration.',
      'manual_export',
    );
  }
  if (inputs.programApproval === 'pending') {
    return result(
      'needs_review',
      'provider_review_pending',
      'Waiting for platform app review.',
      'manual_export',
    );
  }
  if (inputs.programApproval === 'denied') {
    return result(
      'disabled',
      'provider_review_denied',
      'The platform has not approved this use.',
      'manual_export',
    );
  }
  if (inputs.runtimeHealth === 'revoked') {
    return result(
      'disabled',
      'connection_revoked',
      'The account was disconnected. Reconnect it to publish.',
      'reconnect',
    );
  }
  if (inputs.runtimeHealth === 'needs_reauth') {
    return result('disabled', 'needs_reauth', 'The account needs to be reconnected.', 'reconnect');
  }
  const missing = inputs.requiredScopes.filter((s) => !inputs.grantedScopes.includes(s));
  if (missing.length > 0) {
    return result(
      'missing_scope',
      `missing_scope:${missing.join(',')}`,
      'The connection is missing a required permission. Reconnect and grant it.',
      'reconnect',
    );
  }
  if (!inputs.accountTypeSupported) {
    return result(
      'not_supported',
      'account_type_unsupported',
      'This account type cannot publish through the API.',
      'manual_export',
    );
  }
  if (!inputs.formatSupported) {
    return result(
      'not_supported',
      'format_unsupported',
      'This destination does not accept this format.',
      'manual_export',
    );
  }
  if (!inputs.visibilitySupported) {
    return result(
      'not_supported',
      'visibility_unsupported',
      'This destination does not support the chosen visibility.',
    );
  }
  if (!inputs.policyAllows) {
    return result('disabled', 'policy_denied', 'Page publishing rules do not allow this.');
  }
  if (inputs.runtimeHealth === 'degraded') {
    return result(
      'enabled',
      'provider_degraded',
      'Enabled, but the platform recently returned errors.',
    );
  }
  if (inputs.runtimeHealth === 'unknown') {
    return result(
      'enabled',
      'health_unknown',
      'Enabled. Relay has not checked this connection with the platform yet.',
    );
  }
  return result('enabled', undefined, 'Enabled');
}
