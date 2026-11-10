import { describe, expect, it } from 'vitest';
import { mergeCorsRules, relayCorsRule } from './storage';

describe('mergeCorsRules', () => {
  const ours = relayCorsRule(['https://relay.example']);

  it('adds the rule to an empty configuration', () => {
    expect(mergeCorsRules([], ours)).toEqual([ours]);
  });

  it('keeps rules for other origins and replaces the one that mentions ours', () => {
    const other = { AllowedOrigins: ['http://localhost:3000'], AllowedMethods: ['GET'] };
    const stale = { AllowedOrigins: ['https://relay.example'], AllowedMethods: ['GET'] };
    expect(mergeCorsRules([other, stale], ours)).toEqual([other, ours]);
  });

  it('drops a shared rule that lists one of our origins next to another', () => {
    const shared = {
      AllowedOrigins: ['https://relay.example', 'https://old.example'],
      AllowedMethods: ['GET'],
    };
    expect(mergeCorsRules([shared], ours)).toEqual([ours]);
  });

  it('is idempotent', () => {
    const once = mergeCorsRules([], ours);
    expect(mergeCorsRules(once, ours)).toEqual(once);
  });
});
