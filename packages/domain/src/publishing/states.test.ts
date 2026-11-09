import { describe, expect, it } from 'vitest';
import { isAppError } from '../errors';
import { rollupStates } from './rollup';
import {
  DESTINATION_STATES,
  IN_FLIGHT_STATES,
  RESERVING_STATES,
  STATE_DESCRIPTIONS,
  STATE_LABELS,
  TERMINAL_STATES,
  TRANSITION_TRIGGERS,
  TRANSITIONS,
  canTransition,
  nextState,
  type DestinationState,
  type TransitionTrigger,
} from './states';

const edges = (from: DestinationState) =>
  Object.entries(TRANSITIONS[from]) as Array<[TransitionTrigger, DestinationState]>;

describe('destination state machine', () => {
  it('defines every state, label and description, and only targets known states', () => {
    for (const s of DESTINATION_STATES) {
      expect(TRANSITIONS[s]).toBeDefined();
      expect(STATE_LABELS[s]).toBeTruthy();
      expect(STATE_DESCRIPTIONS[s]).toBeTruthy();
      for (const [, to] of edges(s)) expect(DESTINATION_STATES).toContain(to);
    }
  });

  it('uses every trigger somewhere and reaches every state from draft', () => {
    const used = new Set(DESTINATION_STATES.flatMap((s) => edges(s).map(([t]) => t)));
    expect([...used].sort()).toEqual([...TRANSITION_TRIGGERS].sort());
    const seen = new Set<DestinationState>(['draft']);
    const queue: DestinationState[] = ['draft'];
    while (queue.length) {
      for (const [, to] of edges(queue.shift()!)) {
        if (seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    expect([...seen].sort()).toEqual([...DESTINATION_STATES].sort());
  });

  it('has no way out of published or canceled', () => {
    expect(edges('published')).toEqual([]);
    expect(edges('canceled')).toEqual([]);
    // Other terminal states only reopen through a new revision (edit) or withdrawal.
    for (const s of TERMINAL_STATES)
      for (const [t] of edges(s)) expect(['edit', 'withdraw']).toContain(t);
  });

  it('cannot edit, cancel, block or pause a post once dispatch is claimed', () => {
    for (const s of ['dispatching', 'processing'] as const) {
      for (const t of ['edit', 'withdraw', 'block', 'unschedule', 'reschedule'] as const)
        expect(canTransition(s, t)).toBe(false);
    }
  });

  it('never resends from an unknown outcome without proof', () => {
    // From needs_reconciliation nothing leads straight back into dispatch; the only path to a
    // new attempt is the provider proving the post was not sent (reconciled_not_sent).
    const targets = edges('needs_reconciliation');
    expect(targets.map(([, to]) => to)).not.toContain('dispatching');
    expect(targets.map(([, to]) => to)).not.toContain('preparing');
    expect(targets.filter(([, to]) => to === 'scheduled').map(([t]) => t)).toEqual([
      'reconciled_not_sent',
    ]);
    expect(canTransition('needs_reconciliation', 'retry')).toBe(false);
  });

  it('only retries from a failed (not rejected) destination', () => {
    const retryable = DESTINATION_STATES.filter((s) => canTransition(s, 'retry'));
    expect(retryable).toEqual(['failed']);
  });

  it('keeps in-flight and reserving sets consistent with the table', () => {
    for (const s of IN_FLIGHT_STATES) expect(RESERVING_STATES.has(s)).toBe(true);
    for (const s of TERMINAL_STATES) expect(RESERVING_STATES.has(s)).toBe(false);
  });

  it('throws a readable invalid_transition error', () => {
    try {
      nextState('published', 'edit');
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('invalid_transition');
      expect((error as Error).message).toBe('Cannot edit a destination that is published.');
      expect(isAppError(error) && error.details).toEqual({ from: 'published', trigger: 'edit' });
    }
    expect(nextState('scheduled', 'claim_dispatch')).toBe('dispatching');
  });
});

describe('rollupStates', () => {
  it('summarises uniform, empty and mixed posts', () => {
    expect(rollupStates([])).toEqual({ kind: 'empty', label: 'No destinations' });
    expect(rollupStates(['published', 'published'])).toEqual({
      kind: 'uniform',
      state: 'published',
      label: 'Published',
      total: 2,
    });
    const mixed = rollupStates(['published', 'needs_reconciliation', 'published', 'failed']);
    expect(mixed).toMatchObject({ kind: 'mixed', total: 4, attention: 'needs_reconciliation' });
    expect(mixed.label).toBe('Mixed: 2 published, 1 outcome unknown, 1 failed');
  });

  it('produces the same label whatever order destinations load in', () => {
    const a = rollupStates(['failed', 'scheduled', 'published']);
    const b = rollupStates(['published', 'failed', 'scheduled']);
    expect(a.label).toBe(b.label);
    expect(a.label).toBe('Mixed: 1 scheduled, 1 published, 1 failed');
  });
});
