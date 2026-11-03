import { ForwardLanding } from './features/ports/ForwardLanding';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useSyncExternalStore } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ErrorBoundary } from './components/error-boundary';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { TokenGate } from './features/auth/TokenGate';
import { CursorHost } from './features/cursor/CursorHost';
import { ProfilePicker } from './features/profile/ProfilePicker';
import { useCurrentProfileId } from './features/profile/profile-store';
import { ShellLayout } from './features/shell/ShellLayout';
import { tokenStore } from './lib/transport/auth';
import { toastError } from './lib/transport/errors';
import { useProfiles } from './lib/queries/queries';

// Route-level chunks: each page loads on first visit, not up front.
const Dashboard = lazy(() =>
  import('./features/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const Workspace = lazy(() =>
  import('./features/workspace/Workspace').then((m) => ({ default: m.Workspace })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
  },
  // The safety net: an action that fails is ALWAYS reported, even if its call
  // site forgot a handler. Local `onError`s still run for their side effects
  // and report through the same helper, whose message-derived toast id
  // collapses the pair into one toast rather than stacking duplicates.
  mutationCache: new MutationCache({ onError: (error) => toastError(error) }),
});

function Gated() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  // A stored profile id that merely LOOKS valid (10-hex) but is no longer a real
  // profile — e.g. after a daemon change, or a stale id left in localStorage —
  // must fall back to the picker, not render a homepage bound to a profile that
  // doesn't exist (which showed a nameless "…" profile and an empty dashboard).
  // While the list is still loading we can't tell, so don't flash the picker.
  const unknownProfile =
    profileId !== null &&
    profiles.data !== undefined &&
    !profiles.data.some((p) => p.id === profileId);
  if (profileId === null || unknownProfile) return <ProfilePicker />;
  return (
    // useTransitions={false}: by default react-router v7+ wraps every location
    // update in React.startTransition, so under React 19 a navigation defers —
    // `history.push` changes the URL synchronously but the matched route only
    // renders once the transition commits, which for this app (no pending-state
    // UI, Suspense fallback=null) left clicks changing the URL while the view
    // stayed put until a reload. We want urgent, synchronous navigation.
    <BrowserRouter useTransitions={false}>
      <Suspense fallback={null}>
        <Routes>
          <Route element={<ShellLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/project/:id" element={<Workspace />} />
            {/* The session route is the workspace; diff and history are left-
                sidebar navigators (SPEC §8), not routes. */}
            <Route path="/project/:id/session/:sid" element={<Workspace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export function App() {
  const token = useSyncExternalStore(tokenStore.subscribe, tokenStore.get);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <CursorHost />
        {/* The outer net: whatever the routed view's own boundary does not catch
            — the shell, the providers, the token gate — still says something
            rather than emptying the window (components/error-boundary). */}
        <ErrorBoundary scope="app">
          {token ? (
            window.location.pathname.startsWith('/forward/') ? (
              <ForwardLanding />
            ) : (
              <Gated />
            )
          ) : (
            <TokenGate />
          )}
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
