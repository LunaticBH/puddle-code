import { useEffect, useMemo, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useClientSettings } from '../../../lib/settings/client-settings';
import { debounce, type Debounced } from '../../../lib/debounce';
import { useHotkeyLabel } from '../../../lib/navigation/hotkeys';
import {
  putUntitled,
  updateCachedUntitled,
  useUntitledFile,
} from '../../../lib/queries/untitled-queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { registerEditorKeybindings } from '../monaco/editor-keybindings';
import { THEME_NAME, monaco } from '../monaco/monaco-setup';
import { editorIndentationOptions } from '../monaco/monaco-options';
import { publishUntitledContent, requestUntitledSave } from '../buffers/untitled-save-store';
import { useCodeViewState } from '../monaco/monaco-view-state';

/** How long after the last keystroke the draft persists to the profile store. */
const PERSIST_DEBOUNCE_MS = 800;

/**
 * The body of an `untitled` tab (SPEC §8): a worktree-agnostic draft living in
 * the profile's untitled store. Edits persist continuously (debounced) to the
 * daemon, so the draft survives reloads and other machines see it; ⌘S opens
 * the Workspace's save-as dialogue, which places the draft into the bound
 * worktree and swaps this tab for an ordinary file tab. Deliberately outside
 * the shared buffer store — that machinery (drafts, peer sync, 409 flows) is
 * keyed to worktree files, which a draft only becomes on save.
 */
export function UntitledTabBody({ name }: { name: string }) {
  const settings = useClientSettings();
  const profileId = useCurrentProfileId();
  const restoreView = useCodeViewState([profileId, name]);
  const file = useUntitledFile(profileId, name);
  const queryClient = useQueryClient();
  const saveKey = useHotkeyLabel('editor.save');
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const writerRef = useRef<Debounced<[content: string]> | null>(null);
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  useEffect(() => {
    if (profileId === null) return;
    const writer = debounce((content: string) => {
      putUntitled(profileId, name, content).catch((e: unknown) =>
        toast.error(e instanceof Error ? e.message : 'Draft not saved'),
      );
    }, PERSIST_DEBOUNCE_MS);
    writerRef.current = writer;
    return () => {
      writer.flush();
      writerRef.current = null;
    };
  }, [profileId, name]);

  if (profileId === null) return null;
  if (file.error) {
    return (
      <div className="flex h-full items-center justify-center bg-ground text-sm text-fg-muted">
        {file.error instanceof Error ? file.error.message : 'Failed to load the draft'}
      </div>
    );
  }
  if (file.data === undefined) {
    return <div className="p-3 text-xs text-fg-muted">…</div>;
  }

  const saveAs = () => {
    const editor = editorRef.current;
    if (!editor) return;
    writerRef.current?.flush();
    requestUntitledSave({ name, content: editor.getValue() });
  };

  return (
    <div className="flex h-full flex-col bg-ground">
      <div className="bg-surface px-3 py-1 text-xs text-fg-muted">
        Draft — not in any worktree; {saveKey} saves it into one
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          path={`puddle-untitled://${profileId}/${name}`}
          defaultValue={file.data.content}
          theme={THEME_NAME}
          keepCurrentModel={false}
          saveViewState={false}
          loading={<div className="p-3 text-xs text-fg-muted">…</div>}
          onMount={(editor) => {
            restoreView(editor);
            editorRef.current = editor;
            publishUntitledContent(name, editor.getValue());
            registerEditorKeybindings(editor, { onSave: saveAs });
          }}
          onChange={(value) => {
            const content = value ?? '';
            publishUntitledContent(name, content);
            updateCachedUntitled(queryClient, profileId, name, content);
            writerRef.current?.(content);
          }}
          options={{
            automaticLayout: true,
            fontFamily: fontMono,
            fontSize: settings.editorFontSize,
            ...editorIndentationOptions(settings.editorTabSize),
            minimap: { enabled: false },
            fixedOverflowWidgets: true,
            scrollBeyondLastLine: false,
            wordWrap: settings.editorWordWrap ? 'on' : 'off',
          }}
        />
      </div>
    </div>
  );
}
