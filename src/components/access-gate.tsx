import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import './access-gate.css';

type AccessGateProps = {
  children: ReactNode;
};

type GateState = 'checking' | 'locked' | 'submitting' | 'authenticated' | 'locking' | 'error';

type SessionResponse = {
  authenticated?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
};

type AccessControlValue = {
  lockWorkspace: () => Promise<void>;
  isLocking: boolean;
  lockError?: string;
};

const AccessControlContext = createContext<AccessControlValue | null>(null);

export function useAccessControl() {
  return useContext(AccessControlContext);
}

async function readSessionResponse(response: Response): Promise<SessionResponse> {
  let payload: SessionResponse;
  try {
    payload = await response.json() as SessionResponse;
  } catch {
    throw new Error('The access service returned an unreadable response. Please try again.');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('That license key was not accepted. Check it and try again.');
    }
    if (payload.error?.code === 'WEB_CONFIGURATION_MISSING') {
      throw new Error('License-key access is not configured on the server yet. Contact the workspace administrator.');
    }
    if (response.status === 429) {
      throw new Error(payload.error?.message ?? 'Too many attempts. Wait a minute before trying again.');
    }
    throw new Error('Artboard Ai could not verify access right now. Please try again.');
  }

  return payload;
}

function JerseyMark() {
  return (
    <svg className="aa-gate-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M15.5 7.5 5 13l4.2 10.1 5.2-2.5v20h19.2v-20l5.2 2.5L43 13 32.5 7.5c-1.7 2.6-4.5 4.1-8.5 4.1s-6.8-1.5-8.5-4.1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M20 18h8M20 22h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".62" />
      <path d="M24 27v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function AccessGate({ children }: AccessGateProps) {
  const [state, setState] = useState<GateState>('checking');
  const [accessCode, setAccessCode] = useState('');
  const [message, setMessage] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState('checking');
    setMessage('');

    void (async () => {
      try {
        const response = await fetch('/api/session', {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        const session = await readSessionResponse(response);
        if (typeof session.authenticated !== 'boolean') {
          throw new Error('The access service returned an unexpected response. Please try again.');
        }
        if (!controller.signal.aborted) {
          setState(session.authenticated ? 'authenticated' : 'locked');
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : 'Unable to check access. Please try again.');
        setState('error');
      }
    })();

    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const submitAccessCode = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessCode.trim() || state === 'submitting') return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState('submitting');
    setMessage('');

    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode }),
      });
      const session = await readSessionResponse(response);
      if (session.authenticated !== true) {
        throw new Error('That access code was not accepted. Check it and try again.');
      }
      if (!controller.signal.aborted) {
        setAccessCode('');
        setState('authenticated');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(error instanceof Error ? error.message : 'Unable to verify that code. Please try again.');
      setState('locked');
      inputRef.current?.focus();
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [accessCode, state]);

  const lockWorkspace = useCallback(async () => {
    if (state === 'locking') return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState('locking');
    setMessage('');
    try {
      const response = await fetch('/api/session', {
        method: 'DELETE',
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error('Artboard Ai could not lock the workspace. Please try again.');
      }
      if (!controller.signal.aborted) {
        setState('locked');
        setMessage('Workspace locked.');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(error instanceof Error ? error.message : 'Unable to lock the workspace. Please try again.');
      setState('authenticated');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [state]);

  if (state === 'authenticated' || state === 'locking') {
    return (
      <AccessControlContext.Provider
        value={{
          lockWorkspace,
          isLocking: state === 'locking',
          lockError: state === 'authenticated' && message ? message : undefined,
        }}
      >
        <div className="aa-gate-authenticated">{children}</div>
      </AccessControlContext.Provider>
    );
  }

  return (
    <main className="aa-gate" aria-labelledby="aa-gate-title">
      <div className="aa-gate-grid" aria-hidden="true" />
      <div className="aa-gate-shell">
        <header className="aa-gate-brand">
          <JerseyMark />
          <div>
            <p className="aa-gate-brand-name">JERSEY OS</p>
            <p className="aa-gate-brand-sub">PRIVATE WORKSPACE</p>
          </div>
        </header>

        <section className="aa-gate-card">
          <div className="aa-gate-index" aria-hidden="true"><span>01</span><i /></div>
          {state === 'checking' ? (
            <div className="aa-gate-checking" role="status" data-testid="status-session-check">
              <span className="aa-gate-skeleton aa-gate-skeleton-short" />
              <span className="aa-gate-skeleton aa-gate-skeleton-title" />
              <span className="aa-gate-skeleton aa-gate-skeleton-line" />
              <span className="aa-gate-skeleton aa-gate-skeleton-input" />
              <span className="aa-gate-skeleton aa-gate-skeleton-button" />
              <span className="aa-gate-sr-only">Checking private workspace access…</span>
            </div>
          ) : (
            <>
              <p className="aa-gate-eyebrow">ARTWORK REVIEW / ACCESS</p>
              <h1 id="aa-gate-title">A private<br /><span>workroom.</span></h1>
              <p className="aa-gate-description">
                Enter your Jersey OS license key to review jersey artwork and exports.
              </p>

              {state === 'error' && (
                <div className="aa-gate-alert" role="alert" data-testid="status-access-error">
                  <span className="aa-gate-alert-mark" aria-hidden="true">!</span>
                  <span>{message}</span>
                </div>
              )}
              <form className="aa-gate-form" onSubmit={submitAccessCode}>
                <label htmlFor="aa-gate-access-code">LICENSE KEY</label>
                <input
                  ref={inputRef}
                  id="aa-gate-access-code"
                  name="accessCode"
                  type="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={accessCode}
                  onChange={(event) => setAccessCode(event.target.value)}
                  placeholder="Enter your Jersey OS license key"
                  disabled={state === 'submitting'}
                  aria-describedby="aa-gate-help"
                  data-testid="input-access-code"
                />
                <p className="aa-gate-help" id="aa-gate-help">
                  This license key grants your team access to the shared artwork workspace.
                </p>
                {state === 'locked' && message && (
                  <p className="aa-gate-inline-status aa-gate-inline-status-error" role="alert" data-testid="status-access-error">
                    {message}
                  </p>
                )}
                <button
                  className="aa-gate-submit"
                  type="submit"
                  disabled={!accessCode.trim() || state === 'submitting'}
                  data-testid="button-submit-access"
                >
                  <span>{state === 'submitting' ? 'Verifying license…' : 'Enter workspace'}</span>
                  <span className="aa-gate-submit-arrow" aria-hidden="true">{state === 'submitting' ? '···' : '↗'}</span>
                </button>
              </form>
            </>
          )}
          <footer className="aa-gate-card-foot">
            <span>JERSEY OS</span>
            <span>ARTBOARD AI</span>
          </footer>
        </section>

        <p className="aa-gate-footer">Private access for your artwork team</p>
      </div>
    </main>
  );
}

export default AccessGate;
