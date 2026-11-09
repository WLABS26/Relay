import type { Clock, ConnectionMode, DestinationProviderId } from '@relay/domain';
import { createSimulatorMetricsAdapter, createSimulatorPublishingAdapter, type SimulatorStore } from './simulator';
import type { MetricsAdapter, PublishingAdapter } from './types';

/**
 * Adapter resolution. Simulated accounts resolve to the simulator only when demo mode is on.
 * Live accounts resolve to a real adapter or to nothing: a live connection NEVER falls back
 * to the simulator. M1 ships no live adapters; capability checks surface that as
 * `not_supported` with a manual-export fallback.
 */
export interface AdapterRegistry {
  publishing(provider: DestinationProviderId, mode: ConnectionMode): PublishingAdapter | null;
  metrics(provider: DestinationProviderId, mode: ConnectionMode): MetricsAdapter | null;
}

export interface RegistryDeps {
  demoMode: boolean;
  clock: Clock;
  simulatorStore?: SimulatorStore;
  /** Real adapters, keyed by provider (M3+). */
  live?: Partial<Record<DestinationProviderId, { publishing?: PublishingAdapter; metrics?: MetricsAdapter }>>;
  simulatorPollIntervalMs?: number;
  simulatorRateLimitSeconds?: number;
}

export function createAdapterRegistry(deps: RegistryDeps): AdapterRegistry {
  const simCache = new Map<DestinationProviderId, PublishingAdapter>();
  const simMetricsCache = new Map<DestinationProviderId, MetricsAdapter>();
  return {
    publishing(provider, mode) {
      if (mode === 'live') return deps.live?.[provider]?.publishing ?? null;
      if (!deps.demoMode || !deps.simulatorStore) return null;
      let adapter = simCache.get(provider);
      if (!adapter) {
        adapter = createSimulatorPublishingAdapter(provider, {
          store: deps.simulatorStore,
          clock: deps.clock,
          pollIntervalMs: deps.simulatorPollIntervalMs,
          rateLimitSeconds: deps.simulatorRateLimitSeconds,
        });
        simCache.set(provider, adapter);
      }
      return adapter;
    },
    metrics(provider, mode) {
      if (mode === 'live') return deps.live?.[provider]?.metrics ?? null;
      if (!deps.demoMode) return null;
      let adapter = simMetricsCache.get(provider);
      if (!adapter) {
        adapter = createSimulatorMetricsAdapter(provider);
        simMetricsCache.set(provider, adapter);
      }
      return adapter;
    },
  };
}
