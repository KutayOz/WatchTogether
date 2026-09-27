import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import type { PasskeyListItem } from '../../types';
import { AppShell } from '../ui/AppShell';
import { Button, IconButton } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { TextField } from '../ui/Field';
import { AlertIcon, CheckIcon, PasskeyIcon, PlusIcon, TrashIcon } from '../ui/icons';
import { shake } from '../ui/interactions';
import { cascade, rise, spring } from '../ui/motion';
import './settings.css';

/**
 * Settings — for now just the passkey manager. A user can add new passkeys
 * (Touch ID, security key, phone) and remove old ones.
 *
 * Registration flow:
 *   1. Click "Add a passkey" → server returns CredentialCreateOptions
 *   2. Browser invokes WebAuthn create() → user verifies via biometric
 *   3. We ask for a name (a dialog, not window.prompt), then POST the
 *      attestation back → server stores public key
 *
 * Passwords are deliberately absent from this screen. They can be set at signup
 * and replaced through a root-issued reset link, but there is no
 * set/change/remove card here yet — so a password is invisible from this page,
 * and the only sign of one is that removing your last passkey may be allowed
 * when you would expect it not to be. The server enforces the real rule (at
 * least one credential of any kind must remain, see db/signInMethods.ts) and
 * returns its own message when it refuses.
 */
export function Settings() {
  const { user } = useAuthContext();
  const [items, setItems] = useState<PasskeyListItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // The name dialog stands in for window.prompt: registration awaits it.
  const [naming, setNaming] = useState<{ value: string; fallback: string; resolve: (label: string) => void } | null>(
    null,
  );
  const [removing, setRemoving] = useState<PasskeyListItem | null>(null);

  const load = async () => {
    try {
      const { items } = await api.passkeyList();
      setItems(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load passkeys');
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (error) shake(errorRef.current);
  }, [error]);

  const askForLabel = (fallback: string) =>
    new Promise<string>((resolve) => setNaming({ value: fallback, fallback, resolve }));

  const finishNaming = (label: string | null) => {
    if (!naming) return;
    const chosen = label?.trim() || naming.fallback;
    naming.resolve(chosen);
    setNaming(null);
  };

  const handleAdd = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      // Lazy import for the same reason as login — only users on this page
      // pay the ~15KB cost of @simplewebauthn/browser.
      const { startRegistration } = await import('@simplewebauthn/browser');
      const options = await api.passkeyBeginAddition();
      const attestation = await startRegistration({
        optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
      });

      // Default label uses the rough device kind from the user-agent hint.
      // Server will fall back to "Passkey added on YYYY-MM-DD" if empty.
      const label = await askForLabel(guessDeviceLabel());

      await api.passkeyFinishRegistration(attestation, label);
      setSuccess(`Added “${label}”.`);
      await load();
    } catch (err) {
      // SimpleWebAuthn throws a friendly DOMException on user cancel —
      // swallow that one quietly, surface anything else.
      const name = (err as { name?: string })?.name;
      if (name !== 'NotAllowedError') {
        setError(err instanceof Error ? err.message : 'Passkey registration failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    const item = removing;
    if (!item) return;
    setRemoving(null);
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.passkeyRemove(item.credentialId);
      setSuccess(`Removed “${item.label}”.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove passkey');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="settings">
        <header className="page-head">
          <div>
            <h1>Settings</h1>
            <p className="page-head__sub">
              Signed in as <strong style={{ color: 'var(--amber-hi)' }}>{user?.tag}</strong>.
            </p>
          </div>
        </header>

        <m.section className="card settings__card" aria-labelledby="passkeys-title" variants={rise} initial="hidden" animate="shown">
          <div className="settings__card-head">
            <span className="settings__icon" aria-hidden="true">
              <PasskeyIcon size={20} />
            </span>
            <div className="settings__card-title">
              <h2 id="passkeys-title" className="section-title">
                Passkeys
              </h2>
              <p className="section-sub">Sign in with Touch ID, Windows Hello, your phone or a security key.</p>
            </div>
            <Button variant="primary" icon={<PlusIcon size={18} />} onClick={handleAdd} loading={busy} disabled={busy}>
              {busy ? 'Waiting…' : 'Add a passkey'}
            </Button>
          </div>

          <AnimatePresence>
            {success && (
              <m.div
                key={success}
                className="notice notice--ok"
                role="status"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring.soft}
              >
                <CheckIcon size={18} />
                <span>{success}</span>
              </m.div>
            )}
          </AnimatePresence>
          {error && (
            <div ref={errorRef} className="notice notice--error" role="alert">
              <AlertIcon size={18} />
              <span>{error}</span>
            </div>
          )}

          {items === null ? (
            <p className="muted">Loading your passkeys…</p>
          ) : items.length === 0 ? (
            <div className="empty settings__empty">
              <PasskeyIcon size={30} />
              <p className="empty__title">No passkeys yet</p>
              <p className="empty__text">Add one so you can sign in on this device without a password.</p>
            </div>
          ) : (
            <m.ul className="passkeys" variants={cascade(0.06)} initial="hidden" animate="shown">
              <AnimatePresence initial={false}>
                {items.map((item) => (
                  <m.li
                    key={item.credentialId}
                    layout
                    variants={rise}
                    exit={{ opacity: 0, x: -24, transition: { duration: 0.2 } }}
                    className="passkey-row"
                  >
                    <span className="passkey-row__icon" aria-hidden="true">
                      <PasskeyIcon size={18} />
                    </span>
                    <div className="passkey-row__text">
                      <span className="passkey-row__label">{item.label}</span>
                      <span className="passkey-row__meta">
                        Added {new Date(item.registeredAt).toLocaleDateString()}
                        {item.lastUsedAt && <>, last used {new Date(item.lastUsedAt).toLocaleDateString()}</>}
                      </span>
                    </div>
                    {item.backedUp && <span className="chip chip--teal">Synced</span>}
                    <IconButton
                      label={`Remove passkey ${item.label}`}
                      size="sm"
                      bare
                      disabled={busy}
                      onClick={() => setRemoving(item)}
                    >
                      <TrashIcon size={17} />
                    </IconButton>
                  </m.li>
                ))}
              </AnimatePresence>
            </m.ul>
          )}
        </m.section>
      </div>

      <Modal
        isOpen={naming !== null}
        onClose={() => finishNaming(null)}
        title="Name this passkey"
        description="So you can tell your devices apart later."
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => finishNaming(null)}>
              Use “{naming?.fallback}”
            </Button>
            <Button variant="primary" type="submit" form="passkey-name-form">
              Save
            </Button>
          </>
        }
      >
        <form
          id="passkey-name-form"
          onSubmit={(e) => {
            e.preventDefault();
            finishNaming(naming?.value ?? null);
          }}
        >
          <TextField
            label="Name"
            value={naming?.value ?? ''}
            onValueChange={(v) => setNaming((n) => (n ? { ...n, value: v } : n))}
            maxLength={64}
            data-autofocus=""
          />
        </form>
      </Modal>

      <Modal
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this passkey?"
        description={removing ? `You won’t be able to sign in with “${removing.label}” any more.` : undefined}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button variant="danger" icon={<TrashIcon size={17} />} onClick={confirmRemove} data-autofocus="">
              Remove
            </Button>
          </>
        }
      />
    </AppShell>
  );
}

/**
 * Best-effort device label from the user-agent. Pretty rough — we're just
 * giving the user a starting point they can override in the dialog. The
 * real source of truth is the server's AaGuid mapping which we don't
 * use here yet.
 */
function guessDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/Mac OS X/i.test(ua)) return 'Mac (Touch ID)';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Passkey';
}
