import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CompilationFailure, CompilationRunResponse } from '@puddle/shared';
import { CompilationWatcher } from '../../src/features/editor/compilation/CompilationWatcher';
import { MediaViewer } from '../../src/features/editor/previews/MediaViewer';
import { bumpMediaRefresh } from '../../src/features/editor/previews/media-refresh-store';
import '../../src/styles/app.css';

const query = new QueryClient();
const source = { session: 'session', path: 'document.tex', root: '/project' };

function Fixture() {
  const [revisions, setRevisions] = useState<number[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const onResult = useCallback((_key: string, _leaf: string, result: CompilationRunResponse) => {
    setRevisions((previous) => [...previous, result.revision]);
    const preview = result.artifacts.find((artifact) => artifact.role === 'preview');
    if (preview) bumpMediaRefresh(preview.file.session, preview.file.path, preview.file.root);
  }, []);
  const onRunningChange = useCallback((_key: string, value: boolean) => setRunning(value), []);
  const onError = useCallback((_key: string, failure: CompilationFailure) => {
    setError(failure.message);
  }, []);

  return (
    <QueryClientProvider client={query}>
      <CompilationWatcher
        target={{ source, provider: 'latex' }}
        sourceKey="document"
        leafId="pane"
        onResult={onResult}
        onError={onError}
        onRunningChange={onRunningChange}
      />
      <output aria-label="Delivered revisions">{revisions.join(',')}</output>
      <output aria-label="Compilation state">{running ? 'running' : 'settled'}</output>
      <output aria-label="Compilation error">{error}</output>
      <div style={{ height: 600, width: 650 }}>
        {revisions.length > 0 && (
          <MediaViewer
            session="session"
            path="document.pdf"
            root="/project/output"
            kind="pdf"
            generatedBy="latex"
          />
        )}
      </div>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
