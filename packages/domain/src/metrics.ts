/**
 * Metric semantics. A true zero is numeric zero; anything else that is not a value carries an
 * explicit availability code. Observations are compared only when their definitions match.
 */

export const METRIC_AVAILABILITY = [
  'available',
  'not_supported',
  'missing_scope',
  'not_yet_reported',
  'expired',
  'rate_limited',
  'suppressed',
] as const;
export type MetricAvailability = (typeof METRIC_AVAILABILITY)[number];

export const AVAILABILITY_LABELS: Record<MetricAvailability, string> = {
  available: 'Available',
  not_supported: 'Not reported by this platform',
  missing_scope: 'Needs an extra permission',
  not_yet_reported: 'Not reported yet',
  expired: 'Expired under the data retention policy',
  rate_limited: 'Delayed by platform rate limits',
  suppressed: 'Withheld by the platform',
};

export const METRIC_AGGREGATIONS = ['cumulative_snapshot', 'period_aggregate', 'estimate'] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export const METRIC_UNITS = ['count', 'seconds', 'ratio', 'currency'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** Observation ages Relay tries to capture after a confirmed publication. */
export const AGE_BUCKETS = [
  { key: '24h', hours: 24 },
  { key: '72h', hours: 72 },
  { key: '7d', hours: 24 * 7 },
  { key: '30d', hours: 24 * 30 },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]['key'];

export interface MetricDefinitionRef {
  provider: string;
  metricKey: string;
  definitionVersion: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
}

/** Only identical definitions (provider, key, version, unit, aggregation) may be compared or rolled up. */
export function definitionsComparable(a: MetricDefinitionRef, b: MetricDefinitionRef): boolean {
  return (
    a.provider === b.provider &&
    a.metricKey === b.metricKey &&
    a.definitionVersion === b.definitionVersion &&
    a.unit === b.unit &&
    a.aggregation === b.aggregation
  );
}

/** Stable identity of an observation for idempotent upserts. */
export function observationKey(input: { ageBucket?: AgeBucket | null; periodStart?: string | null; periodEnd?: string | null }): string {
  if (input.ageBucket) return `age:${input.ageBucket}`;
  if (input.periodStart && input.periodEnd) return `period:${input.periodStart}/${input.periodEnd}`;
  return 'latest';
}
