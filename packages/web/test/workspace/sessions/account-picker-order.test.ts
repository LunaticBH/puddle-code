import { describe, expect, it } from 'vitest';
import {
  accountPickerLabel,
  orderAccountPickerItems,
} from '../../../src/features/workspace/sessions/account-picker-order';

describe('new-agent account picker order', () => {
  const accounts = [
    { id: 1, agent_type: 'claude-code', label: 'waddle-team' },
    { id: 2, agent_type: 'claude-code', label: 'waddle-max' },
    { id: 3, agent_type: 'codex', label: 'harvard' },
    { id: 4, agent_type: 'codex', label: 'waddle' },
    { id: 5, agent_type: 'claude-code', label: 'harvard' },
  ];

  it('sorts by the full displayed agent/account label', () => {
    expect(orderAccountPickerItems(accounts).map(accountPickerLabel)).toEqual([
      'claude-code/harvard',
      'claude-code/waddle-max',
      'claude-code/waddle-team',
      'codex/harvard',
      'codex/waddle',
    ]);
  });

  it('does not mutate the API result order', () => {
    const original = [...accounts];
    orderAccountPickerItems(accounts);
    expect(accounts).toEqual(original);
  });
});
