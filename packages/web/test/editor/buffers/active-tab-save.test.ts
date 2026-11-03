import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNTITLED_SESSION } from '@puddle/shared';
import { requestActiveTabSave } from '../../../src/features/editor/buffers/active-tab-save';
import {
  registerSaver,
  saveCompilationInputs,
  saverKey,
} from '../../../src/features/editor/buffers/save-registry';
import {
  forgetUntitledContent,
  publishUntitledContent,
  setUntitledSaveHandler,
} from '../../../src/features/editor/buffers/untitled-save-store';

afterEach(() => {
  setUntitledSaveHandler(null);
  forgetUntitledContent('untitled-1.md');
});

describe('requestActiveTabSave', () => {
  it('saves only the ordinary file tab it is given', () => {
    const envSave = vi.fn();
    const otherSave = vi.fn();
    const saveAs = vi.fn();
    const removeEnv = registerSaver(saverKey('session', '.env'), envSave);
    const removeOther = registerSaver(saverKey('session', 'other.ts'), otherSave);
    setUntitledSaveHandler(saveAs);
    publishUntitledContent('untitled-1.md', 'draft');

    expect(requestActiveTabSave({ session: 'session', path: '.env' })).toBe(true);
    expect(envSave).toHaveBeenCalledOnce();
    expect(otherSave).not.toHaveBeenCalled();
    expect(saveAs).not.toHaveBeenCalled();

    removeEnv();
    removeOther();
  });

  it('opens save-as only when the active tab itself is untitled', () => {
    const saveAs = vi.fn();
    setUntitledSaveHandler(saveAs);
    publishUntitledContent('untitled-1.md', 'draft');

    expect(
      requestActiveTabSave({
        kind: 'untitled',
        session: UNTITLED_SESSION,
        path: 'untitled-1.md',
      }),
    ).toBe(true);
    expect(saveAs).toHaveBeenCalledWith({ name: 'untitled-1.md', content: 'draft' });
  });
});

describe('saveCompilationInputs', () => {
  it('awaits only provider inputs in the source file tree', async () => {
    const mainSave = vi.fn(async () => true);
    const bibliographySave = vi.fn(async () => true);
    const unrelatedSave = vi.fn(async () => true);
    const otherRootSave = vi.fn(async () => true);
    const remove = [
      registerSaver(saverKey('session', 'main.tex'), mainSave, {
        session: 'session',
        path: 'main.tex',
      }),
      registerSaver(saverKey('session', 'refs.bib'), bibliographySave, {
        session: 'session',
        path: 'refs.bib',
      }),
      registerSaver(saverKey('session', 'notes.md'), unrelatedSave, {
        session: 'session',
        path: 'notes.md',
      }),
      registerSaver(saverKey('session', 'other.tex', '/tmp/other'), otherRootSave, {
        session: 'session',
        path: 'other.tex',
        root: '/tmp/other',
      }),
    ];

    await expect(
      saveCompilationInputs(
        { session: 'session', path: 'main.tex' },
        new Set(['tex', 'bib', 'sty']),
      ),
    ).resolves.toBe(true);
    expect(mainSave).toHaveBeenCalledOnce();
    expect(bibliographySave).toHaveBeenCalledOnce();
    expect(unrelatedSave).not.toHaveBeenCalled();
    expect(otherRootSave).not.toHaveBeenCalled();
    remove.forEach((dispose) => dispose());
  });

  it('blocks compilation when a matching save reports failure', async () => {
    const remove = registerSaver(saverKey('session', 'main.tex'), async () => false, {
      session: 'session',
      path: 'main.tex',
    });
    await expect(
      saveCompilationInputs({ session: 'session', path: 'main.tex' }, new Set(['tex'])),
    ).resolves.toBe(false);
    remove();
  });
});
