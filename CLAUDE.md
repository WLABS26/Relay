# Relay

- Spec: `docs/RELAY_BUILD_SPEC.md`. Progress, constraints and the next task:
  `docs/implementation-status.md` (keep it current at the end of every session).
- Read both, then `git log` and `git diff`, before changing anything; never re-scaffold completed work.

## Commands

`pnpm infra:up`, `pnpm db:migrate`, `pnpm fixtures:generate`, `pnpm db:seed`, `pnpm dev`,
`pnpm worker:dev`. Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`,
`pnpm test:e2e`, `pnpm format:check`.

## Rules

- All behaviour goes through `packages/services`; route handlers and worker tasks stay thin.
- Schema changes are new SQL migrations plus `pnpm db:types`; never edit an applied migration.
- Tenant data only inside `withTenant` (or a documented bootstrap scope); RLS is forced.
- Inject the clock and ID generator; no `Date.now()`/random in domain logic.
- Simulated is never "live": label simulator data everywhere; never fall back to it in live mode.
- External side effects (deploys, migrations on shared databases, provider consoles, live posts) need explicit operator action.
- Write invisible or bidirectional Unicode as escapes; `pnpm lint` fails otherwise.
