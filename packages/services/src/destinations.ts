import { sql, type Tx } from '@relay/db';
import { AppError, nextState, type DestinationState, type TransitionTrigger } from '@relay/domain';

/**
 * The single write path for post-destination state. It applies the domain transition table
 * and a compare-and-set on the current state, so two writers can never both move the same
 * destination from the same state.
 */
export async function transitionDestination(
  tx: Tx,
  input: {
    postDestinationId: string;
    from: DestinationState;
    trigger: TransitionTrigger;
    reason?: string | null;
    now: Date;
    set?: Record<string, unknown>;
  },
): Promise<{ to: DestinationState; version: number }> {
  const to = nextState(input.from, input.trigger);
  const row = await tx
    .updateTable('postDestinations')
    .set({
      ...(input.set ?? {}),
      state: to,
      stateReason: input.reason ?? null,
      stateChangedAt: input.now,
      version: sql`version + 1`,
    })
    .where('id', '=', input.postDestinationId)
    .where('state', '=', input.from)
    .returning(['version'])
    .executeTakeFirst();
  if (!row) {
    throw new AppError(
      'version_conflict',
      'This destination changed while you were working on it. Reload and try again.',
    );
  }
  return { to, version: row.version };
}

/** Lock rows in the documented order (see docs/architecture/locking.md). */
export async function lockForScheduling(
  tx: Tx,
  ids: { socialAccountId: string; pageId: string; postDestinationId: string },
) {
  const account = await tx
    .selectFrom('socialAccounts')
    .selectAll()
    .where('id', '=', ids.socialAccountId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const page = await tx
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', ids.pageId)
    .forShare()
    .executeTakeFirstOrThrow();
  const destination = await tx
    .selectFrom('postDestinations')
    .selectAll()
    .where('id', '=', ids.postDestinationId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { account, page, destination };
}

/** Resolve the lock targets of a post destination without locking anything. */
export async function destinationRefs(tx: Tx, postDestinationId: string) {
  return tx
    .selectFrom('postDestinations as pd')
    .innerJoin('posts as p', 'p.id', 'pd.postId')
    .innerJoin('pageDestinations as d', 'd.id', 'pd.pageDestinationId')
    .select([
      'pd.id',
      'pd.postId',
      'p.pageId',
      'd.socialAccountId',
      'd.provider',
      'p.currentRevisionId',
    ])
    .where('pd.id', '=', postDestinationId)
    .executeTakeFirst();
}

let savepointCounter = 0;

/**
 * Run `fn` inside a SQL savepoint of the current transaction: on failure only its writes are
 * rolled back. Used for batch commands that report per-item outcomes.
 */
export async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const name = `relay_sp_${++savepointCounter}`;
  await sql.raw(`SAVEPOINT ${name}`).execute(tx);
  try {
    const result = await fn();
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(tx);
    return result;
  } catch (error) {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(tx);
    throw error;
  }
}
