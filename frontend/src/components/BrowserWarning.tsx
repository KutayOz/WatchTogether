import {
  SectionTitle,
  StickerButton,
  TagSticker,
  Chibi,
  SpeechBubble,
} from './manga';

interface BrowserWarningProps {
  type: 'blocking' | 'dismissible';
  message: string;
  onDismiss?: () => void;
}

interface BrowserLink {
  href: string;
  label: string;
  bg: string;
  fg: string;
  emoji: string;
}

const BROWSERS: BrowserLink[] = [
  { href: 'https://www.google.com/chrome/',  label: 'Chrome',  bg: 'var(--pink)',   fg: 'var(--ink)',   emoji: '🌐' },
  { href: 'https://www.mozilla.org/firefox/', label: 'Firefox', bg: 'var(--orange)', fg: 'var(--ink)',   emoji: '🦊' },
  { href: 'https://www.microsoft.com/edge',   label: 'Edge',    bg: 'var(--purple)', fg: 'var(--cream)', emoji: '🔷' },
];

export function BrowserWarning({ type, message, onDismiss }: BrowserWarningProps) {
  if (type === 'blocking') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(26,20,23,0.92)',
          zIndex: 9999,
          display: 'grid',
          placeItems: 'center',
          animation: 'fadeIn 0.3s ease-out forwards',
          padding: 16,
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 580,
            background: 'var(--cream)',
            border: '4.5px solid var(--ink)',
            boxShadow: '12px 12px 0 var(--ink)',
            padding: '26px 32px',
            transform: 'rotate(-1deg)',
            animation: 'postcardIn 0.55s cubic-bezier(.34,1.56,.64,1)',
          }}
        >
          <div className="row" style={{ alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <SectionTitle size={36} underline="orange">BROWSER OOPS</SectionTitle>
            <TagSticker color="orange" rot={4}>NOT SUPPORTED</TagSticker>
          </div>

          <div
            style={{
              marginTop: 22,
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              flexWrap: 'wrap',
            }}
          >
            <Chibi who="sprout" pose="wave" size={140} />
            <SpeechBubble kind="cloud" color="cream" style={{ width: 280, height: 150 }}>
              <span className="hand" style={{ fontSize: 19, lineHeight: 1.25, display: 'block' }}>
                {message}
              </span>
            </SpeechBubble>
          </div>

          <p className="hand" style={{ fontSize: 22, marginTop: 18, color: 'rgba(26,20,23,0.7)' }}>
            try one of these instead ↓
          </p>

          <div
            style={{
              marginTop: 14,
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 12,
            }}
          >
            {BROWSERS.map((b, i) => (
              <a
                key={b.label}
                href={b.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  textDecoration: 'none',
                  background: b.bg,
                  color: b.fg,
                  border: '3px solid var(--ink)',
                  borderRadius: 12,
                  boxShadow: '4px 4px 0 var(--ink)',
                  padding: '14px 8px',
                  textAlign: 'center',
                  transform: `rotate(${(i % 2 ? 1 : -1) * 1.5}deg)`,
                  transition: 'transform .18s, box-shadow .18s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'rotate(0) translate(-2px,-2px) scale(1.05)';
                  e.currentTarget.style.boxShadow = '6px 6px 0 var(--ink)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = `rotate(${(i % 2 ? 1 : -1) * 1.5}deg)`;
                  e.currentTarget.style.boxShadow = '4px 4px 0 var(--ink)';
                }}
              >
                <div style={{ fontSize: 32, marginBottom: 4 }}>{b.emoji}</div>
                <div style={{ fontFamily: 'var(--font-sfx)', fontSize: 16, letterSpacing: 1 }}>{b.label}</div>
              </a>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Dismissible warning
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26,20,23,0.55)',
        zIndex: 9000,
        display: 'grid',
        placeItems: 'center',
        animation: 'fadeIn 0.25s ease-out forwards',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 460,
          background: 'var(--cream)',
          border: '4.5px solid var(--ink)',
          boxShadow: '12px 12px 0 var(--ink)',
          padding: '24px 28px',
          transform: 'rotate(-1deg)',
          animation: 'postcardIn 0.55s cubic-bezier(.34,1.56,.64,1)',
        }}
      >
        <SectionTitle size={28} underline="purple">PSST</SectionTitle>
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
          }}
        >
          <Chibi who="pip" pose="wave" size={100} />
          <SpeechBubble kind="oval" color="cream">
            <span className="hand" style={{ fontSize: 18, display: 'block', lineHeight: 1.3 }}>
              {message}
            </span>
          </SpeechBubble>
        </div>
        <div className="row" style={{ marginTop: 22, justifyContent: 'flex-end' }}>
          <StickerButton color="purple" size="md" sfx="KLIK" onClick={onDismiss}>
            OK GOT IT
          </StickerButton>
        </div>
        <p
          className="hand"
          style={{ marginTop: 14, fontSize: 16, color: 'rgba(26,20,23,0.55)', textAlign: 'center' }}
        >
          for the smoothest call: chrome, firefox, or edge ♥
        </p>
      </div>
    </div>
  );
}
