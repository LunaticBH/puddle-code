import { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaViewer } from '../../src/features/editor/previews/MediaViewer';
import { TabViewStateContext } from '../../src/features/editor/tabs/view-state-context';
import '../../src/styles/app.css';
const Surface = lazy(() =>
  import('./view-state-surfaces').then((module) => ({ default: module.Surface })),
);

function Fixture() {
  const [project, setProject] = useState('first');
  const [revision, setRevision] = useState(0);
  const kind = new URLSearchParams(location.search).get('view');
  return (
    <>
      <nav>
        <button onClick={() => setProject('first')}>First project</button>
        <button onClick={() => setProject('second')}>Second project</button>
        <button onClick={() => setRevision((value) => value + 1)}>Recompile</button>
      </nav>
      <div style={{ height: 600, width: 650 }}>
        <TabViewStateContext.Provider value={project}>
          {kind === 'parked-terminal' ? (
            <Suspense fallback="Loading fixture…">
              {['first', 'second'].map((name) => (
                <div
                  key={name}
                  style={{ height: '100%', display: project === name ? undefined : 'none' }}
                >
                  <Surface kind="terminal" project={name} paused={project !== name} />
                </div>
              ))}
            </Suspense>
          ) : kind ? (
            <Suspense fallback="Loading fixture…">
              <Surface key={project} kind={kind} project={project} />
            </Suspense>
          ) : (
            <MediaViewer
              key={project}
              refreshKey={revision}
              session="session"
              path="document.pdf"
              root="/project"
              kind="pdf"
              generatedBy={
                new URLSearchParams(location.search).has('ordinary') ? undefined : 'latex'
              }
              onRevealSource={() => {}}
            />
          )}
        </TabViewStateContext.Provider>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
