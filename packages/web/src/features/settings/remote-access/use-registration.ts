import { useEffect, useRef, useState } from 'react';
import {
  desktopRegistrationSchema,
  registrationStatusSchema,
  REMOTE_POLICY,
  type CockpitRemoteRequest,
  type DesktopRegistration,
} from '@puddle/shared';
import { api } from '../../../lib/transport/api';

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function useRegistration(
  disabled: boolean,
  enable: (request: CockpitRemoteRequest) => Promise<boolean>,
) {
  const [attempt, setAttempt] = useState<{
    request: DesktopRegistration;
    code: string;
    url: string;
  } | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const prepared = useRef<{ code: string; challenge: string } | null>(null);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (attempt) return;
    let live = true;
    prepared.current = null;
    setPreparing(true);
    const prepare = async () => {
      try {
        const code = hex(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = hex(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))),
        );
        if (live) prepared.current = { code, challenge };
      } catch (failure) {
        if (live)
          setError(failure instanceof Error ? failure.message : 'Could not prepare sign-in.');
      } finally {
        if (live) setPreparing(false);
      }
    };
    void prepare();
    return () => {
      live = false;
      prepared.current = null;
    };
  }, [attempt]);
  const enableRef = useRef(enable);
  useEffect(() => {
    enableRef.current = enable;
  }, [enable]);
  useEffect(() => {
    if (!attempt) return;
    const timer = setTimeout(
      () => {
        generation.current += 1;
        setAttempt(null);
        setError('Sign-in expired. Try again.');
      },
      Math.max(0, attempt.request.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [attempt]);
  useEffect(() => {
    if (!attempt || disabled) return;
    const current = generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (attempt.request.expires <= Date.now()) throw new Error('Sign-in expired. Try again.');
        const { ready } = registrationStatusSchema.parse(
          await api('POST', '/cockpit/remote/registration', {
            service: attempt.request.service,
            code: attempt.code,
          }),
        );
        if (stopped || current !== generation.current) return;
        if (attempt.request.expires <= Date.now()) throw new Error('Sign-in expired. Try again.');
        if (ready) {
          // Clear the verifier before the one-shot mutation. Never retry an uncertain enable.
          setAttempt(null);
          await enableRef.current({
            t: 'enable',
            registration: {
              service: attempt.request.service,
              app: attempt.request.app,
              code: attempt.code,
            },
          });
        } else timer = setTimeout(() => void poll(), 2000);
      } catch (failure) {
        if (stopped || current !== generation.current) return;
        setAttempt(null);
        setError(failure instanceof Error ? failure.message : 'Sign-in failed. Try again.');
      }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [attempt, disabled]);
  const begin = (service: string, app: string, label: string) => {
    if (disabled || !prepared.current) return;
    setError('');
    try {
      const { code, challenge } = prepared.current;
      const parsed = desktopRegistrationSchema.safeParse({
        service: service.trim(),
        app: app.trim(),
        label: label.trim(),
        challenge,
        expires: Date.now() + REMOTE_POLICY.invitationMs,
      });
      if (!parsed.success)
        throw new Error('Enter a host name and exact HTTPS application and relay origins.');
      const request = parsed.data;
      const url = `${request.app}/#register=${encodeURIComponent(JSON.stringify(request))}`;
      generation.current += 1;
      prepared.current = null;
      setAttempt({ request, code, url });
      // Stay on this click's call stack: browser tabs open on the UI machine,
      // and Electron forwards HTTPS links to that desktop's system browser.
      // No opener command is sent to the daemon/SSH host. The visible link is
      // still available when the user's browser blocks new tabs.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start sign-in.');
    }
  };
  return {
    attempt,
    preparing,
    error,
    begin,
    cancel: () => {
      generation.current += 1;
      prepared.current = null;
      setPreparing(true);
      setAttempt(null);
    },
  };
}
