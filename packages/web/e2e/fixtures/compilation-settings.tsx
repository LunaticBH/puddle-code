import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditorSection } from '../../src/features/settings/sections/editor';
import { CompilationSettingsDialog } from '../../src/features/editor/compilation/CompilationSettingsDialog';
import { profileStore } from '../../src/features/profile/profile-store';
import { applyTheme } from '../../src/lib/appearance/theme';
import '../../src/styles/app.css';

applyTheme('dark');
profileStore.set('aaaaaaaaaa');
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const request = {
  profile_id: 'aaaaaaaaaa',
  project_id: 'bbbbbbbbbb',
  provider: 'python',
  source: { session: '00000000-0000-0000-0000-000000000000', root: '/source', path: 'script.py' },
};
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <QueryClientProvider client={query}>
      <main className="mx-auto max-w-2xl p-5">
        <EditorSection />
        <button className="mt-6 cursor-pointer text-sm text-fg-muted" onClick={() => setOpen(true)}>
          File settings
        </button>
        <CompilationSettingsDialog request={open ? request : null} onOpenChange={setOpen} />
      </main>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
