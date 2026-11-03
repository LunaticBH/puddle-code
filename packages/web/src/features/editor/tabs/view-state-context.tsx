import { createContext, useContext } from 'react';
import { browserScope } from '../../../lib/transport/browser-transport';

/** A tab's layout/pane identity, separate from its shared file buffer. */
export const TabViewStateContext = createContext('');

export function useViewStateKey(surface: string, target: unknown): string {
  const tab = useContext(TabViewStateContext);
  // Capture the transport scope now: cleanup must not write into a new host.
  return browserScope(JSON.stringify([tab, surface, target]));
}
