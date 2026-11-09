import {
  addDays,
  AVAILABILITY_LABELS,
  resultsQuerySchema,
  startOfLocalDay,
  type MetricAvailability,
} from '@relay/domain';
import { accessiblePageIds, authorize, inWorkspace, type AuthenticatedUser } from './access';
import type { ServiceContext } from './context';

/**
 * Results read model. Metrics are grouped by exact definition (provider, key, version, unit),
 * compared only at the same observation age, and always carry availability, provenance and
 * freshness. Simulated metrics are labelled as such and never blended with live ones.
 */
export async function getResults(
  ctx: ServiceContext,
  user: AuthenticatedUser,
  workspaceId: string,
  rawQuery: unknown,
) {
  const query = resultsQuerySchema.parse(rawQuery);
  return inWorkspace(ctx, user, workspaceId, async (tx, member) => {
    if (query.pageId) authorize(member, 'results.view', query.pageId);
    else authorize(member, 'workspace.view');
    const workspace = await tx
      .selectFrom('workspaces')
      .select(['timezone'])
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    const visible = accessiblePageIds(member);
    let q = tx
      .selectFrom('externalPublications as e')
      .innerJoin('postDestinations as pd', 'pd.id', 'e.postDestinationId')
      .innerJoin('posts as p', 'p.id', 'pd.postId')
      .innerJoin('pages as pg', 'pg.id', 'p.pageId')
      .innerJoin('pageDestinations as d', 'd.id', 'pd.pageDestinationId')
      .leftJoin('postRevisions as r', 'r.id', 'p.currentRevisionId')
      .select([
        'e.id',
        'e.externalId',
        'e.permalink',
        'e.provider',
        'e.connectionMode',
        'e.visibility',
        'e.format',
        'e.publishedAt',
        'e.plannedAt',
        'e.linkMethod',
        'e.isSample',
        'p.id as postId',
        'p.title',
        'r.caption',
        'pg.id as pageId',
        'pg.name as pageName',
        'pg.goal',
        'd.label as destinationLabel',
        'p.isSample as postIsSample',
      ])
      .where('e.status', '=', 'live')
      .orderBy('e.publishedAt', 'desc')
      .limit(500);
    if (query.pageId) q = q.where('p.pageId', '=', query.pageId);
    if (query.provider) q = q.where('e.provider', '=', query.provider);
    if (query.format) q = q.where('e.format', '=', query.format);
    if (query.from)
      q = q.where('e.publishedAt', '>=', startOfLocalDay(query.from, workspace.timezone));
    if (query.to)
      q = q.where('e.publishedAt', '<', startOfLocalDay(addDays(query.to, 1), workspace.timezone));
    if (visible)
      q = q.where(
        'p.pageId',
        'in',
        visible.length ? visible : ['00000000-0000-0000-0000-000000000000'],
      );
    const publications = await q.execute();
    const ids = publications.map((p) => p.id);
    const observations = ids.length
      ? await tx
          .selectFrom('metricObservations as o')
          .innerJoin('metricDefinitions as m', 'm.id', 'o.metricDefinitionId')
          .select([
            'o.externalPublicationId',
            'o.observationKey',
            'o.ageBucket',
            'o.value',
            'o.availability',
            'o.observedAt',
            'o.provenance',
            'o.sourcePolicy',
            'o.revision',
            'm.id as definitionId',
            'm.provider as definitionProvider',
            'm.metricKey',
            'm.definitionVersion',
            'm.unit',
            'm.aggregation',
            'm.label',
            'm.description',
          ])
          .where('o.externalPublicationId', 'in', ids)
          .execute()
      : [];

    const definitions = new Map<
      string,
      {
        id: string;
        label: string;
        unit: string;
        provider: string;
        metricKey: string;
        version: string;
        aggregation: string;
        description: string;
      }
    >();
    for (const o of observations) {
      definitions.set(o.definitionId, {
        id: o.definitionId,
        label: o.label,
        unit: o.unit,
        provider: o.definitionProvider,
        metricKey: o.metricKey,
        version: o.definitionVersion,
        aggregation: o.aggregation,
        description: o.description,
      });
    }
    const rows = publications.map((p) => {
      const obs = observations.filter((o) => o.externalPublicationId === p.id);
      const metrics: Record<
        string,
        Record<
          string,
          {
            value: number | null;
            availability: MetricAvailability;
            availabilityLabel: string;
            observedAt: string;
            revision: number;
          }
        >
      > = {};
      for (const o of obs) {
        metrics[o.definitionId] ??= {};
        metrics[o.definitionId]![o.observationKey] = {
          value: o.value === null ? null : Number(o.value),
          availability: o.availability as MetricAvailability,
          availabilityLabel: AVAILABILITY_LABELS[o.availability as MetricAvailability],
          observedAt: o.observedAt.toISOString(),
          revision: o.revision,
        };
      }
      const freshest = obs.reduce<Date | null>(
        (acc, o) => (!acc || o.observedAt > acc ? o.observedAt : acc),
        null,
      );
      return {
        ...p,
        publishedAt: p.publishedAt.toISOString(),
        plannedAt: p.plannedAt?.toISOString() ?? null,
        simulated: p.connectionMode === 'simulated',
        metrics,
        asOf: freshest?.toISOString() ?? null,
      };
    });

    // Comparison panels: one per definition, at a fixed observation age, with cohort coverage.
    const panels = [...definitions.values()].map((def) => {
      const ages = ['age:24h', 'age:72h', 'age:7d', 'latest'] as const;
      const byAge = ages.map((ageKey) => {
        const cells = rows
          .map((r) => r.metrics[def.id]?.[ageKey])
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
        const available = cells.filter((c) => c.availability === 'available' && c.value !== null);
        const values = available.map((c) => c.value!).sort((a, b) => a - b);
        const median = values.length
          ? values.length % 2
            ? values[(values.length - 1) / 2]!
            : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2
          : null;
        const unavailable = cells.filter((c) => c.availability !== 'available');
        return {
          ageKey,
          cohortSize: rows.length,
          observed: cells.length,
          available: available.length,
          coverage: rows.length ? available.length / rows.length : 0,
          median,
          unavailableReasons: [...new Set(unavailable.map((c) => c.availabilityLabel))],
        };
      });
      return { definition: def, simulated: def.provider === 'simulator', byAge };
    });
    return {
      member,
      zone: workspace.timezone,
      publications: rows,
      definitions: [...definitions.values()],
      panels,
      totals: {
        publications: rows.length,
        simulated: rows.filter((r) => r.simulated).length,
        live: rows.filter((r) => !r.simulated).length,
      },
    };
  });
}
