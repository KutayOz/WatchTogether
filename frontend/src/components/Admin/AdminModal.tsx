import { SectionTitle } from '../manga';

/**
 * The backroom's one modal shape.
 *
 * Lifted out of UserTable when the demo-request queue arrived needing the same
 * thing — a small postcard over a dimmed page, dismissed by clicking away —
 * rather than copied, because both of its callers show a link that exists in
 * exactly one place and the "copy this now" affordance has to look identical
 * wherever it appears.
 */
export function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26,20,23,0.55)',
        zIndex: 7500,
        display: 'grid',
        placeItems: 'center',
        animation: 'fadeIn 0.25s ease-out forwards',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--cream)',
          border: '4.5px solid var(--ink)',
          boxShadow: '12px 12px 0 var(--ink)',
          padding: '24px 28px',
          maxWidth: 440,
          width: '100%',
          animation: 'postcardIn 0.55s cubic-bezier(.34,1.56,.64,1)',
          transform: 'rotate(-1deg)',
        }}
      >
        <SectionTitle size={28} underline="purple">{title}</SectionTitle>
        <div style={{ marginTop: 18 }}>{children}</div>
      </div>
    </div>
  );
}
