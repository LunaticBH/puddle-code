import '../../src/features/editor/monaco/monaco-setup';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndContext } from '@dnd-kit/core';
import type { CompilationProvider, LayoutLeaf } from '@puddle/shared';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { EditorProvider } from '../../src/features/workspace/editor-context';
import { PaneTabStrip } from '../../src/features/workspace/panes/PaneTabStrip';
import { PaneEditorBody } from '../../src/features/editor/PaneEditorBody';
import { requestSave, saverKey } from '../../src/features/editor/buffers/save-registry';
import { tabRefKey } from '../../src/features/workspace/layout/layout-tree';
import '../../src/styles/app.css';
import { applyTheme } from '../../src/lib/appearance/theme';

applyTheme('dark');

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const source = {
  session: '00000000-0000-0000-0000-000000000000',
  root: '/project',
  path: 'analysis.ipynb',
  kind: 'external' as const,
  view: 'preview' as const,
};
const providers: CompilationProvider[] = [
  {
    id: 'notebook',
    display_name: 'Jupyter notebook',
    extensions: ['ipynb'],
    input_extensions: ['ipynb'],
    eager: false,
    available: true,
    executor: 'jupyter-nbconvert',
    action: 'run',
  },
  {
    id: 'latex',
    display_name: 'LaTeX',
    extensions: ['tex'],
    input_extensions: ['tex'],
    eager: true,
    available: true,
    executor: 'latexmk',
  },
];

function Fixture() {
  const [leaf, setLeaf] = useState<LayoutLeaf>({
    id: 'notebook',
    type: 'leaf',
    tabs: [
      { type: 'editor', tab: source },
      { type: 'editor', tab: { ...source, path: 'paper.tex', view: 'source' } },
    ],
    activeKey: tabRefKey({ type: 'editor', tab: source }),
    previewKey: null,
  });
  const active = leaf.tabs.find((tab) => tabRefKey(tab) === leaf.activeKey);
  return (
    <QueryClientProvider client={query}>
      <TooltipProvider>
        <EditorProvider>
          <DndContext sensors={[]}>
            <div className="flex h-screen flex-col">
              <PaneTabStrip
                leaf={leaf}
                sessions={[]}
                onActivate={(ref) => setLeaf({ ...leaf, activeKey: tabRefKey(ref) })}
                onClose={() => {}}
                onPromote={() => {}}
                onArchived={() => {}}
                onSetView={(ref, view) => {
                  if (ref.type === 'editor') {
                    const updated = { ...ref, tab: { ...ref.tab, view } };
                    setLeaf({
                      ...leaf,
                      tabs: leaf.tabs.map((tab) => (tab === ref ? updated : tab)),
                      activeKey: tabRefKey(updated),
                    });
                  }
                }}
                compilableExtensions={new Set(['ipynb', 'tex'])}
                compilationProviders={providers}
                compilationRunningKeys={new Set()}
                onRunCompilation={() => {}}
                onSetCompilationMode={() => {}}
                onNewFile={() => {}}
                onRevealFile={() => {}}
                onRenameFile={async () => false}
              />
              <button
                className="cursor-pointer p-2 text-fg-muted"
                onClick={() => requestSave(saverKey(source.session, source.path, source.root))}
              >
                Save notebook
              </button>
              <div className="min-h-0 flex-1">
                {active?.type === 'editor' && (
                  <PaneEditorBody
                    tab={active.tab}
                    onRunCompilation={() => {
                      window.dispatchEvent(new Event('notebook-run'));
                    }}
                    reveal={null}
                    focused
                    scrollDriver={false}
                    scrollReceiver={false}
                    scrollChannel="notebook"
                  />
                )}
              </div>
            </div>
          </DndContext>
        </EditorProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
