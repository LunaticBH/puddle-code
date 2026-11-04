import { describe, expect, it, vi } from 'vitest';
import {
  bufferKey,
  getOrCreateModel,
  isDirty,
  rekeyBuffer,
} from '../../../src/features/editor/buffers/buffer-store';

/**
 * Buffer identity under a Windows root, against a stand-in for monaco (which
 * cannot initialise under vitest). A case-only rename is a real move of the
 * buffer, and two files whose names differ only in case, which a
 * case-sensitive directory (WSL's DrvFs) holds side by side, keep a buffer
 * each. POSIX roots run the same assertions.
 */

const monacoStub = vi.hoisted(() => {
  class FakeModel {
    private version = 1;
    constructor(
      private value: string,
      public language: string,
    ) {}
    getValue(): string {
      return this.value;
    }
    getAlternativeVersionId(): number {
      return this.version;
    }
    onDidChangeContent(): { dispose(): void } {
      return { dispose() {} };
    }
    dispose(): void {}
    /** Test-only: an edit, as typing would make. */
    type(value: string): void {
      this.value = value;
      this.version += 1;
    }
  }
  return {
    FakeModel,
    monaco: {
      Uri: { parse: (uri: string) => ({ uri }) },
      editor: {
        getModel: () => null,
        createModel: (value: string, language: string) => new FakeModel(value, language),
        setModelLanguage: (model: FakeModel, language: string) => {
          model.language = language;
        },
      },
      languages: { getLanguages: () => [{ id: 'javascript', extensions: ['.js'] }] },
    },
  };
});

vi.mock('../../../src/features/editor/monaco/monaco-setup', () => ({ monaco: monacoStub.monaco }));

type FakeModel = InstanceType<typeof monacoStub.FakeModel>;
const open = (session: string, path: string, content: string, root: string) =>
  getOrCreateModel(session, path, content, 5, root) as unknown as FakeModel;

describe.each([
  ['a Windows root', 'C:\\wsl\\repo'],
  ['a POSIX root', '/home/a/repo'],
])('buffers under %s', (_label, root) => {
  it('move on a case-only rename, keeping the unsaved text and taking the new language', () => {
    const session = `rename:${root}`;
    const model = open(session, 'x.JS', 'saved', root);
    expect(model.language).toBe('plaintext');
    model.type('unsaved');

    const snapshot = rekeyBuffer(session, 'x.JS', 'x.js', root);

    // A null snapshot would leave renameFileTab deleting the only draft.
    expect(snapshot).toEqual({ content: 'unsaved', baseMtimeMs: 5, dirty: true });
    expect(model.language).toBe('javascript');
    expect(isDirty(bufferKey(session, 'x.js', root))).toBe(true);
    expect(isDirty(bufferKey(session, 'x.JS', root))).toBe(false);
  });

  it('stay apart for two files whose names differ only in case', () => {
    const session = `pair:${root}`;
    const upper = open(session, 'README.md', 'upper', root);
    const mixed = open(session, 'Readme.md', 'mixed', root);
    expect(mixed).not.toBe(upper);
    expect(mixed.getValue()).toBe('mixed');
    expect(open(session, 'README.md', 'ignored', root)).toBe(upper);
  });
});
