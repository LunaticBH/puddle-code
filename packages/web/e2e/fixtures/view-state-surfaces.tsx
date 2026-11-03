import { monaco } from '../../src/features/editor/monaco/monaco-setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { Terminal as XTerm } from '@xterm/xterm';
import { CodeEditor } from '../../src/features/editor/monaco/CodeEditor';
import { MarkdownPreview } from '../../src/features/editor/previews/markdown/MarkdownPreview';
import { HtmlPreview } from '../../src/features/editor/previews/html/HtmlPreview';
import {
  useCodeViewState,
  useDiffViewState,
} from '../../src/features/editor/monaco/monaco-view-state';
import { Terminal } from '../../src/features/terminal/Terminal';
import { PhoneFileText } from '../../src/features/mobile/PhoneFileText';
import { wsManager } from '../../src/lib/transport/ws';
import type { editor } from 'monaco-editor';
import { useEffect, useRef } from 'react';

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const text = Array.from(
  { length: 300 },
  (_, index) => `Line ${index + 1}: ${'content '.repeat(20)}`,
).join('\n');
const initialReveal = { session: 'session', path: 'file.txt', line: 50, nonce: 1 };
let editorInstance: editor.IStandaloneCodeEditor | null = null;
let diffInstance: editor.IStandaloneDiffEditor | null = null;
const terminals: XTerm[] = [];
const originalOpen = XTerm.prototype.open;
XTerm.prototype.open = function (parent) {
  originalOpen.call(this, parent);
  terminals.push(this);
};
wsManager.attach = (_session, _term, _cols, _rows, handlers) => {
  const timer = setTimeout(() => handlers.onData(text.replaceAll('\n', '\r\n'), 'replay'), 20);
  return () => clearTimeout(timer);
};
wsManager.onStatus = () => () => {};
wsManager.resize = () => {};
wsManager.isConnected = () => true;

function PrivateEditor({ diff }: { diff: boolean }) {
  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  useEffect(
    () => () => {
      const instance = diffRef.current;
      const models = instance?.getModel();
      instance?.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
    },
    [],
  );
  const restoreCode = useCodeViewState('private');
  const restoreDiff = useDiffViewState('private');
  return diff ? (
    <DiffEditor
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      original={text}
      modified={text.replace('Line 200:', 'Changed 200:')}
      onMount={(instance) => {
        diffRef.current = instance;
        diffInstance = instance;
        restoreDiff(instance);
      }}
      options={{ automaticLayout: true, scrollBeyondLastLine: false }}
    />
  ) : (
    <Editor
      defaultValue={text}
      keepCurrentModel={false}
      saveViewState={false}
      onMount={(instance) => {
        editorInstance = instance;
        restoreCode(instance);
      }}
      options={{ automaticLayout: true, scrollBeyondLastLine: false }}
    />
  );
}

export function Surface({
  kind,
  project,
  paused = false,
}: {
  kind: string;
  project: string;
  paused?: boolean;
}) {
  const content =
    kind === 'markdown' ? (
      <MarkdownPreview
        session="session"
        path="file.md"
        text={text.split('\n').join('\n\n')}
        scrollDriver
        scrollChannel={project}
      />
    ) : kind === 'html' ? (
      <HtmlPreview
        session="session"
        path="file.html"
        text={`<!doctype html><html><body>${text
          .split('\n')
          .map((line) => `<p>${line}</p>`)
          .join('\n')}</body></html>`}
        scrollDriver
        scrollChannel={project}
      />
    ) : kind === 'code' ? (
      <CodeEditor session="session" path="file.txt" reveal={initialReveal} />
    ) : kind === 'phone-source' ? (
      <div className="flex h-full flex-col">
        <PhoneFileText target="file.txt" content={text} />
      </div>
    ) : kind === 'terminal' ? (
      <Terminal stream={project} paused={paused} />
    ) : (
      <PrivateEditor diff={kind === 'diff'} />
    );
  return <QueryClientProvider client={query}>{content}</QueryClientProvider>;
}

Object.assign(window, {
  viewFixture: {
    editor: () =>
      editorInstance?.getDomNode()?.isConnected
        ? editorInstance
        : monaco.editor.getEditors().find((editor) => editor.getDomNode()?.isConnected),
    diff: () => diffInstance,
    terminal: () =>
      terminals.findLast(
        (terminal) => terminal.element?.isConnected && terminal.element.clientHeight > 0,
      ),
  },
});
