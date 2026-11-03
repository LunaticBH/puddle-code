import { createRoot } from 'react-dom/client';
import { bootstrapToken } from './lib/transport/auth';
import { initClientSettings } from './lib/settings/client-settings';
import { captureHostParam } from './lib/navigation/editor-links';
import { initTheme } from './lib/appearance/theme';
import './styles/app.css';

initTheme();
initClientSettings();
// Order matters: captureHostParam reads the #invite= fragment (its local-mode
// signal) that bootstrapToken strips.
if (import.meta.env.VITE_PUDDLE_REMOTE_SERVICE) {
  if (/^\/(?:guide|faq)\/?$/.test(location.pathname)) {
    if (/^\/faq\/?$/.test(location.pathname)) {
      history.replaceState(null, '', `/guide${location.search}${location.hash}`);
    }
    // Public setup documentation must not depend on sign-in or relay availability.
    void import('./features/guide/GuidePage').then(({ GuidePage }) =>
      createRoot(document.getElementById('root')!).render(<GuidePage />),
    );
  } else {
    void import('./features/remote/RemoteApp').then(({ RemoteApp }) =>
      createRoot(document.getElementById('root')!).render(<RemoteApp />),
    );
  }
} else {
  captureHostParam();
  void bootstrapToken().then(async () => {
    const { App } = await import('./App');
    createRoot(document.getElementById('root')!).render(<App />);
  });
}
