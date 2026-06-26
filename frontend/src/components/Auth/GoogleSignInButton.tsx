import { logger } from '../../services/logger';
import { useEffect, useRef } from 'react';

/**
 * Google Identity Services (GIS) sign-in button.
 *
 * Why Google's own button (not a custom manga sticker): the Google branding
 * guidelines require it, and users recognize the look instantly. The button
 * sits inside our sketchbook background so the visual nesting still reads
 * as "part of this app" — just with one cross-vendor element that breaks
 * the manga frame, which is a fair trade for trust.
 *
 * Why GIS native, not @react-oauth/google: GIS is just a single ~30KB
 * script (browser-cached across the web), no React-tree opinions, no
 * future maintenance from a third-party React wrapper drifting out of
 * sync. The wrapper adds zero functionality we need.
 *
 * The script is lazy-loaded the first time a button renders — landing
 * page visitors who never see this component don't pay the network round
 * trip. Promise is cached at module scope so two concurrent mounts share
 * one fetch.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: { client_id: string; callback: (response: { credential: string }) => void }): void;
          renderButton(element: HTMLElement, options: Record<string, unknown>): void;
          cancel(): void;
        };
      };
    };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadGoogleScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    // If a previous render already loaded the script, skip injecting.
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google sign-in script'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface GoogleSignInButtonProps {
  /** Fired with the raw ID token (a JWT signed by Google). Caller POSTs
   *  it to /api/auth/google for server-side validation + cookie set. */
  onCredential: (idToken: string) => void;
  /** Visual width in CSS pixels. Google's renderButton expects a number. */
  width?: number;
}

export function GoogleSignInButton({ onCredential, width = 240 }: GoogleSignInButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  useEffect(() => {
    if (!clientId || !containerRef.current) return;
    let cancelled = false;

    loadGoogleScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response?.credential) onCredential(response.credential);
          },
        });
        window.google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width,
        });
      })
      .catch((err) => logger.warn('[GIS] script load failed:', err));

    return () => {
      cancelled = true;
    };
  }, [clientId, onCredential, width]);

  if (!clientId) {
    // VITE_GOOGLE_CLIENT_ID not configured — hide silently. Local-dev
    // experience: no broken button, just no Google option.
    return null;
  }

  return (
    <div style={{ display: 'inline-block', transform: 'rotate(-1deg)' }}>
      <div ref={containerRef} aria-label="Continue with Google" />
    </div>
  );
}
