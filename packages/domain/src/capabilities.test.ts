import { describe, expect, it } from 'vitest';
import { resolveCapability, type CapabilityInputs } from './capabilities';

const NOW = new Date('2026-11-09T10:00:00Z');
const ok: CapabilityInputs = {
  implemented: true,
  connectionMode: 'live',
  demoMode: false,
  deploymentEnabled: true,
  programApproval: 'approved',
  requiredScopes: ['publish'],
  grantedScopes: ['publish', 'read'],
  accountTypeSupported: true,
  formatSupported: true,
  visibilitySupported: true,
  policyAllows: true,
  runtimeHealth: 'healthy',
  publishMode: 'api',
};
const resolve = (patch: Partial<CapabilityInputs>) => resolveCapability({ ...ok, ...patch }, NOW);

describe('resolveCapability', () => {
  it('is enabled only when every layer allows it', () => {
    expect(resolve({})).toEqual({
      state: 'enabled',
      message: 'Enabled',
      fallback: null,
      checkedAt: NOW.toISOString(),
    });
  });

  it.each<[string, Partial<CapabilityInputs>, string, string, string | null]>([
    [
      'simulator outside demo mode',
      { connectionMode: 'simulated' },
      'disabled',
      'simulator_disabled',
      null,
    ],
    [
      'no adapter',
      { implemented: false },
      'not_supported',
      'adapter_not_implemented',
      'manual_export',
    ],
    [
      'manual-export destination',
      { publishMode: 'manual_export' },
      'not_supported',
      'manual_export_only',
      'manual_export',
    ],
    [
      'deployment flag off',
      { deploymentEnabled: false },
      'disabled',
      'deployment_disabled',
      'manual_export',
    ],
    [
      'platform review pending',
      { programApproval: 'pending' },
      'needs_review',
      'provider_review_pending',
      'manual_export',
    ],
    [
      'platform review denied',
      { programApproval: 'denied' },
      'disabled',
      'provider_review_denied',
      'manual_export',
    ],
    [
      'revoked connection',
      { runtimeHealth: 'revoked' },
      'disabled',
      'connection_revoked',
      'reconnect',
    ],
    ['reauth needed', { runtimeHealth: 'needs_reauth' }, 'disabled', 'needs_reauth', 'reconnect'],
    [
      'missing scope',
      { grantedScopes: ['read'] },
      'missing_scope',
      'missing_scope:publish',
      'reconnect',
    ],
    [
      'account type',
      { accountTypeSupported: false },
      'not_supported',
      'account_type_unsupported',
      'manual_export',
    ],
    ['format', { formatSupported: false }, 'not_supported', 'format_unsupported', 'manual_export'],
    ['visibility', { visibilitySupported: false }, 'not_supported', 'visibility_unsupported', null],
    ['page policy', { policyAllows: false }, 'disabled', 'policy_denied', null],
  ])(
    'reports %s with its own state, reason and fallback',
    (_, patch, state, reasonCode, fallback) => {
      expect(resolve(patch)).toMatchObject({ state, reasonCode, fallback });
    },
  );

  it('decides by the first failing layer, so the reason is the most fundamental one', () => {
    expect(
      resolve({ implemented: false, deploymentEnabled: false, grantedScopes: [] }).reasonCode,
    ).toBe('adapter_not_implemented');
    expect(resolve({ runtimeHealth: 'revoked', grantedScopes: [] }).reasonCode).toBe(
      'connection_revoked',
    );
  });

  it('allows the simulator only in demo mode', () => {
    expect(resolve({ connectionMode: 'simulated', demoMode: true }).state).toBe('enabled');
  });

  it('stays enabled but says so when health is degraded or not yet known', () => {
    expect(resolve({ runtimeHealth: 'degraded' })).toMatchObject({
      state: 'enabled',
      reasonCode: 'provider_degraded',
    });
    expect(resolve({ runtimeHealth: 'unknown' })).toMatchObject({
      state: 'enabled',
      reasonCode: 'health_unknown',
    });
  });
});
