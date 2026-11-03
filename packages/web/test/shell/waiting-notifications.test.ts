import { describe, expect, it } from 'vitest';
import { decideNotification } from '../../src/features/shell/use-waiting-notifications';

const prefs = (over = {}) => ({
  desktop: true,
  sound: true,
  when_focused: true,
  muted_projects: [] as string[],
  ...over,
});

describe('decideNotification', () => {
  it('notifies by default and only suppresses an interacting session when requested', () => {
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        sessionFocused: false,
        permission: 'granted',
      }),
    ).toEqual({ desktop: true, sound: true });
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        sessionFocused: true,
        permission: 'granted',
      }),
    ).toEqual({ desktop: true, sound: true });
    expect(
      decideNotification({
        prefs: prefs({ when_focused: false }),
        projectId: 'p1',
        sessionFocused: true,
        permission: 'granted',
      }),
    ).toEqual({ desktop: false, sound: true });
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        sessionFocused: true,
        permission: 'unverified',
      }),
    ).toEqual({ desktop: true, sound: true });
    expect(
      decideNotification({
        prefs: prefs(),
        projectId: 'p1',
        sessionFocused: false,
        permission: 'denied',
      }),
    ).toEqual({ desktop: false, sound: true });
  });

  it('a muted project silences both channels', () => {
    expect(
      decideNotification({
        prefs: prefs({ muted_projects: ['p1'] }),
        projectId: 'p1',
        sessionFocused: false,
        permission: 'granted',
      }),
    ).toEqual({ desktop: false, sound: false });
  });

  it('respects the per-channel toggles', () => {
    expect(
      decideNotification({
        prefs: prefs({ desktop: false, sound: false }),
        projectId: 'p1',
        sessionFocused: false,
        permission: 'granted',
      }),
    ).toEqual({ desktop: false, sound: false });
  });
});
