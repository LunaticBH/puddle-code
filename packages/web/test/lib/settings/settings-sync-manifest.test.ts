import { describe, expect, it, vi } from 'vitest';
import {
  applyImport,
  collectExport,
  missingScratchpadEntries,
  portableScratchpad,
  type SyncSinks,
  type SyncSources,
} from '../../../src/lib/settings/settings-sync-manifest';

const entry = (over: Partial<SyncSources['scratchpad'][number]> = {}) => ({
  scope: 'profile',
  title: 'Review checklist',
  body: 'Check the diff for…',
  tags: ['review'],
  agent_type: null,
  ...over,
});

function sources(over: Partial<SyncSources> = {}): SyncSources {
  return {
    client: { cursorPackage: 'rangefinder', uiFontSize: 16, editorTabSize: 2 },
    theme: 'dark',
    profileSettings: {
      captureSessionEnv: false,
      notifications: { desktop: true, sound: true, muted_projects: ['aaaaaaaaaa'] },
    },
    profile: { branch_prefix: 'alice/' },
    scratchpad: [entry()],
    ...over,
  };
}

function sinks(): SyncSinks & {
  calls: {
    settings: Record<string, unknown>[];
    scratchpad: unknown[][];
  };
} {
  const calls = { settings: [] as Record<string, unknown>[], scratchpad: [] as unknown[][] };
  return {
    calls,
    setClient: vi.fn(),
    setTheme: vi.fn(),
    patchProfileSettings: (p) => calls.settings.push(p),
    patchProfileColumns: vi.fn(),
    createScratchpad: (entries) => calls.scratchpad.push(entries),
  };
}

describe('collectExport', () => {
  it('carries the cursor package with the other appearance preferences', () => {
    const doc = collectExport(['appearance'], sources());
    expect(doc.appearance).toMatchObject({ cursorPackage: 'rangefinder', uiFontSize: 16 });
  });

  it('carries captureSessionEnv and strips muted_projects from notifications', () => {
    const doc = collectExport(['sessions', 'notifications'], sources());
    expect(doc.sessions).toMatchObject({ captureSessionEnv: false });
    expect(doc.notifications).toEqual({
      notifications: { desktop: true, sound: true },
    });
  });

  it('exports only profile-scoped scratchpad entries, content only', () => {
    const doc = collectExport(
      ['scratchpad'],
      sources({ scratchpad: [entry(), entry({ scope: 'project', body: 'local only' })] }),
    );
    expect(doc.scratchpad).toEqual({
      entries: [
        {
          title: 'Review checklist',
          body: 'Check the diff for…',
          tags: ['review'],
          agent_type: null,
        },
      ],
    });
  });
});

describe('applyImport', () => {
  it('merges notification prefs over the current object, keeping muted_projects', () => {
    const s = sinks();
    applyImport(
      { notifications: { notifications: { desktop: false, sound: false } } },
      s,
      sources(),
    );
    expect(s.calls.settings).toEqual([
      {
        notifications: { desktop: false, sound: false, muted_projects: ['aaaaaaaaaa'] },
      },
    ]);
  });

  it('restricts to the selected groups in local-sync mode', () => {
    const s = sinks();
    const applied = applyImport(
      {
        sessions: { captureSessionEnv: true },
        notifications: { notifications: { desktop: false } },
      },
      s,
      sources(),
      ['sessions'],
    );
    expect(applied).toEqual(['Sessions']);
    expect(s.calls.settings).toEqual([{ captureSessionEnv: true }]);
  });

  it('creates only the scratchpad entries with no identical local copy', () => {
    const s = sinks();
    const incoming = [
      // identical to the local entry in title+body+tags+agent → skipped
      {
        title: 'Review checklist',
        body: 'Check the diff for…',
        tags: ['review'],
        agent_type: null,
      },
      // same text, different tags → kept (both copies survive)
      { title: 'Review checklist', body: 'Check the diff for…', tags: [], agent_type: null },
      { title: null, body: 'Fresh note', tags: [], agent_type: 'claude-code' },
    ];
    applyImport({ scratchpad: { entries: incoming } }, s, sources());
    expect(s.calls.scratchpad).toEqual([
      [
        { title: 'Review checklist', body: 'Check the diff for…', tags: [], agent_type: null },
        { title: null, body: 'Fresh note', tags: [], agent_type: 'claude-code' },
      ],
    ]);
  });

  it('reports nothing to apply when every incoming entry already exists', () => {
    const s = sinks();
    const applied = applyImport(
      { scratchpad: { entries: portableScratchpad([entry()]) } },
      s,
      sources(),
    );
    expect(applied).toEqual([]);
    expect(s.calls.scratchpad).toEqual([]);
  });
});

describe('missingScratchpadEntries', () => {
  it('dedupes within the payload and ignores malformed rows', () => {
    const dup = { title: 'x', body: 'same', tags: [], agent_type: null };
    expect(missingScratchpadEntries([dup, dup, { body: '' }, 'junk'], [])).toEqual([dup]);
  });

  it('treats empty-string and null titles as the same identity', () => {
    const local = [entry({ title: null, body: 'note', tags: [] })];
    expect(
      missingScratchpadEntries([{ title: '', body: 'note', tags: [], agent_type: null }], local),
    ).toEqual([]);
  });
});
