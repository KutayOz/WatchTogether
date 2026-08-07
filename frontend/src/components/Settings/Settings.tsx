import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import type { PasskeyListItem } from '../../types';
import {
  Sketchbook,
  SectionTitle,
  StickerButton,
  BackButton,
  BurstSticker,
  TagSticker,
  Doodle,
} from '../manga';

/**
 * Settings — for now just the passkey manager. A user can add new passkeys
 * (Touch ID, security key, phone) and remove old ones.
 *
 * Registration flow:
 *   1. Click "Add a passkey" → server returns CredentialCreateOptions
 *   2. Browser invokes WebAuthn create() → user verifies via biometric
 *   3. We POST the attestation back → server stores public key
 *
 * The "Add" button is the only interactive entry into adding credentials;
 * everything else is observation + remove.
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
  const [items, setItems] = useState<PasskeyListItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
      const defaultLabel = guessDeviceLabel();
      const label = window.prompt('Label this passkey:', defaultLabel) ?? defaultLabel;

      await api.passkeyFinishRegistration(attestation, label);
      setSuccess(`Added "${label}"`);
      await load();
    } catch (err) {
      // SimpleWebAuthn throws a friendly DOMException on user cancel —
      // swallow that one quietly, surface anything else.
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError') {
        // user cancelled, no message
      } else {
        setError(err instanceof Error ? err.message : 'Passkey registration failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (item: PasskeyListItem) => {
    if (!window.confirm(`Remove "${item.label}"? You won't be able to sign in with this passkey any more.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.passkeyRemove(item.credentialId);
      setSuccess(`Removed "${item.label}"`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove passkey');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', placeItems: 'center', padding: '20px 0', minHeight: '100vh' }}>
        <Sketchbook style={{ width: '100%', maxWidth: 720 }}>
          <div style={{ marginBottom: 18, position: 'relative' }}>
            <SectionTitle size={42} underline="pink">
              SETTINGS
            </SectionTitle>
            <div style={{ position: 'absolute', right: 0, top: -4 }}>
              <TagSticker color="purple" rot={6}>
                MY STUFF
              </TagSticker>
            </div>
          </div>

          <section style={{ marginTop: 18 }}>
            <SectionTitle size={28} underline="purple">
              passkeys
            </SectionTitle>
            <p className="hand" style={{ fontSize: 18, marginTop: 8, color: 'rgba(26,20,23,0.7)' }}>
              sign in with Touch ID, Windows Hello, or a security key — nothing to remember.
            </p>

            {success && (
              <div className="hand" style={{ marginTop: 12, color: 'var(--purple)', fontSize: 18 }} role="status">
                ✓ {success}
              </div>
            )}
            {error && (
              <div className="shake" style={{ marginTop: 12 }} role="alert">
                <BurstSticker bg="var(--orange)" rot={-3} w={160} h={100}>OOPS!</BurstSticker>
                <div className="hand" style={{ fontSize: 16, marginTop: 4, color: 'var(--ink)' }}>{error}</div>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <StickerButton
                color="pink"
                size="md"
                sfx="TAP!"
                onClick={handleAdd}
                disabled={busy}
              >
                {busy ? 'WAITING…' : '+ ADD A PASSKEY'}
              </StickerButton>
            </div>

            <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items === null ? (
                <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.5)' }}>loading…</div>
              ) : items.length === 0 ? (
                <div
                  className="hand"
                  style={{
                    fontSize: 18,
                    color: 'rgba(26,20,23,0.55)',
                    padding: 18,
                    border: '2.5px dashed rgba(26,20,23,0.3)',
                    background: 'rgba(123, 63, 228, 0.04)',
                    textAlign: 'center',
                  }}
                >
                  no passkeys on file — add one so you can sign in from another device ↑
                </div>
              ) : (
                items.map((item) => <PasskeyRow key={item.credentialId} item={item} onRemove={() => handleRemove(item)} disabled={busy} />)
              )}
            </div>
          </section>

          <div style={{ marginTop: 32 }}>
            <Link to="/" style={{ textDecoration: 'none' }}>
              <BackButton>back to lobby</BackButton>
            </Link>
          </div>

          <div className="margin-doodles" style={{ position: 'absolute', right: 32, bottom: 40 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="sparkle" size={36} color="var(--purple)" />
            </span>
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}

function PasskeyRow({
  item,
  onRemove,
  disabled,
}: {
  item: PasskeyListItem;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        border: '3px solid var(--ink)',
        background: 'var(--cream)',
        boxShadow: '3px 3px 0 var(--ink)',
        transform: 'rotate(-0.2deg)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 16, color: 'var(--ink)' }}>
          {item.label}
        </div>
        <div className="hand" style={{ fontSize: 14, color: 'rgba(26,20,23,0.55)' }}>
          added {new Date(item.registeredAt).toLocaleDateString()}
          {item.lastUsedAt && <> · last used {new Date(item.lastUsedAt).toLocaleDateString()}</>}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove passkey ${item.label}`}
        style={{
          background: 'transparent',
          border: '2.5px solid var(--ink)',
          padding: '4px 10px',
          fontFamily: 'var(--font-sfx)',
          fontSize: 14,
          letterSpacing: 1,
          color: 'var(--orange-deep, var(--orange))',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transform: 'rotate(2deg)',
          opacity: disabled ? 0.4 : 1,
        }}
      >
        REMOVE
      </button>
    </div>
  );
}

/**
 * Best-effort device label from the user-agent. Pretty rough — we're just
 * giving the user a starting point they can override in the prompt. The
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
