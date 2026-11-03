import { Toaster as SonnerToaster } from 'sonner';
import { useSyncExternalStore } from 'react';
import { currentTheme, onThemeChange } from '../../lib/appearance/theme';

/** Toasts follow the active puddle theme and sit on elevated surfaces. */
export function Toaster() {
  const theme = useSyncExternalStore(onThemeChange, currentTheme);
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        style: {
          background: 'var(--bg-elevated)',
          border: 'none',
          boxShadow: '0 8px 30px rgb(0 0 0 / 0.25)',
          color: 'var(--text-primary)',
        },
        classNames: {
          // Failure toasts carry the process's own output as the description:
          // keep its line breaks and set it in the terminal's typeface, or a
          // stack trace arrives as one unreadable run-on line.
          description:
            'whitespace-pre-wrap break-words font-mono text-2xs leading-snug max-h-40 overflow-y-auto',
        },
      }}
    />
  );
}
