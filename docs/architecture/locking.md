# Locking and concurrency

How Relay keeps scheduling and publishing correct when requests, worker tasks and operators
act on the same rows at once. Referenced from `packages/services/src/scheduling.ts` and
`packages/services/src/destinations.ts`.

## Lock order

Every transaction that changes a destination's publishing state locks rows in the same order,
so two concurrent transactions can block each other but never deadlock:

1. **Connected account** (`social_accounts`, `FOR UPDATE`): the account is the unit of pacing
   (one slot per minute, minimum gap, daily and weekly caps), so pacing checks run while it is
   held and two schedules for one account serialise.
2. **Page** (`pages`, `FOR SHARE`): pausing a page takes it `FOR UPDATE`, so a schedule or a
   dispatch claim cannot interleave with a pause.
3. **Workspace** (`workspaces`): workspace-level pause and kill-switch checks.
4. **Post destination** (`post_destinations`, `FOR UPDATE`): the state machine row.
5. Intent and reservation rows for that destination.

`lockForScheduling()` in `destinations.ts` takes 1, 2 and 4; `destinationRefs()` resolves the
IDs without locking. Schedule, move, cancel, the worker's dispatch claim, disconnecting an
account and revoking rights all go through this order.

## Slot reservations

A schedule writes an immutable **publish intent** (operation key
`workspace:destination:revision:intentVersion`) and a **slot reservation**. A unique index
allows one active reservation per account and exact instant, so an exact collision fails even
if two transactions pass the in-memory check; the minimum gap, daily and weekly caps are
evaluated against the account's reservations loaded inside the same transaction, after the
account lock. Cancel and reschedule release or replace the reservation atomically with the
state change. Reservations are kept while a destination is scheduled, in flight, blocked,
awaiting reconciliation or failed; they are consumed on publish and released on cancel or expiry.

## Fenced leases for the worker

The worker claims a destination by writing a **lease token** and expiry on the row, together
with a `publish_attempts` ledger row, before it calls the provider. Every later write checks the
token: a worker that lost its lease (crash, partition, slow network) cannot overwrite progress
made by the worker that took over. Takeover happens through `maintenance.reconcile_due`, which
only re-drives destinations whose lease has expired.

Attempt rows are written **before** the side-effecting phase runs, so a crash after the
provider accepted the post leaves evidence that a request was made. Such a destination moves
to _Outcome unknown_ and is only resumed when the provider proves, by an idempotent lookup on
the operation key, that nothing was sent; otherwise an operator links the external post or
closes it as not published.

## Pause and the claim boundary

Pausing a page or workspace blocks destinations that have not been claimed yet and leaves
in-flight ones to finish (they are reported, never aborted mid-request). Because the pause
takes the page lock, a claim either commits before the pause and continues, or sees the pause
and holds. Resuming re-queues held destinations; ones whose planned time has passed beyond the
late-grace window go back to review instead of publishing late.

## Idempotency and versions

Creating posts, starting uploads and scheduling accept an `Idempotency-Key` recorded inside the
business transaction; a replay returns the original response and a reused key with a
different body is refused. Every state change on an existing destination requires
`expectedVersion`, so a stale client fails with `version_conflict` instead of clobbering.

## Tests

`tests/integration/scheduling.test.ts` (concurrent exact-slot and gap collisions, move/lock/
cancel, pause before and after the claim) and `tests/integration/reliability.test.ts` (worker
death before and after the provider write, lost response, operator close and retry).
