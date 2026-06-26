import { SectionTitle, StickerButton, BackButton, SpeechBubble, Doodle } from '../manga';

interface ScreenShareRequestProps {
  requesterName: string;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * ScreenShareRequest — postcard-style modal asking the user to approve a peer's
 * screen share request. The peer's name is shown in a thought bubble.
 */
export function ScreenShareRequest({ requesterName, onApprove, onDeny }: ScreenShareRequestProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26,20,23,0.55)',
        zIndex: 8000,
        display: 'grid',
        placeItems: 'center',
        animation: 'fadeIn 0.25s ease-out forwards',
        padding: 16,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 480,
          background: 'var(--cream)',
          border: '4.5px solid var(--ink)',
          boxShadow: '12px 12px 0 var(--ink)',
          animation: 'postcardIn 0.55s cubic-bezier(.34,1.56,.64,1)',
          transform: 'rotate(-1deg)',
          padding: '26px 28px 22px',
        }}
      >
        <div className="row" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <SectionTitle size={32} underline="purple">
            SHARE REQUEST
          </SectionTitle>
        </div>

        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <Doodle kind="tv" size={56} color="var(--purple)" />
          <SpeechBubble kind="oval" side="left" color="cream">
            <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700 }}>
              <span style={{ color: 'var(--purple)' }}>{requesterName}</span> wants to share their screen.
            </span>
          </SpeechBubble>
        </div>

        <p className="hand" style={{ fontSize: 20, marginTop: 18, color: 'rgba(26,20,23,0.7)' }}>
          let them?
        </p>

        <div className="row" style={{ marginTop: 22, gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <StickerButton color="pink" sfx="TAP!" onClick={onApprove}>
            ALLOW
          </StickerButton>
          <BackButton onClick={onDeny}>nah</BackButton>
        </div>
      </div>
    </div>
  );
}
