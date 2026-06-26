import type { CSSProperties, ReactNode } from 'react';
import { SpeechBubble } from './primitives';

export type ChibiWho = 'pip' | 'mochi' | 'sprout';
export type ChibiPose = 'wave' | 'peace' | 'sleep' | 'point';

interface ChibiProps {
  who?: ChibiWho;
  pose?: ChibiPose;
  size?: number;
  style?: CSSProperties;
}

export function Chibi({ who = 'pip', pose = 'wave', size = 180, style }: ChibiProps) {
  const baseProps = {
    width: size,
    height: size,
    viewBox: '0 0 200 200',
    style,
    fill: 'none',
    stroke: '#1A1417',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (who === 'pip') {
    return (
      <svg {...baseProps}>
        <defs>
          <pattern id="chibi-pink" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(15)">
            <circle cx="2" cy="2" r="1.2" fill="#FF4FA3" opacity="0.85" />
          </pattern>
        </defs>
        {/* body — overalls */}
        <path
          d="M62 138 Q 58 168 64 188 L 136 188 Q 142 168 138 138 L 122 134 L 100 138 L 78 134 Z"
          fill="#FBF1DD"
          strokeWidth="4"
        />
        <path d="M82 138 L 84 116 L 100 110 L 116 116 L 118 138" strokeWidth="3.5" />
        <path d="M64 138 Q 50 152 48 168" strokeWidth="4" />
        <path d="M136 138 Q 150 152 152 168" strokeWidth="4" />
        {pose === 'wave' && (
          <g>
            <circle cx="156" cy="84" r="11" fill="#FBF1DD" strokeWidth="3.5" />
            <path d="M150 78 L 148 70 M156 74 L 156 66 M162 76 L 164 68" strokeWidth="2.5" />
            <path d="M152 168 Q 150 130 156 96" strokeWidth="3.5" fill="none" />
          </g>
        )}
        {pose !== 'wave' && <circle cx="48" cy="172" r="9" fill="#FBF1DD" strokeWidth="3.5" />}
        <circle cx={pose === 'wave' ? '48' : '152'} cy="172" r="9" fill="#FBF1DD" strokeWidth="3.5" />
        {/* head */}
        <circle cx="100" cy="78" r="50" fill="#FBF1DD" strokeWidth="4.5" />
        {/* hair tuft */}
        <path
          d="M58 60 Q 68 30 92 30 Q 110 18 132 38 Q 148 50 144 70 Q 140 56 124 54 Q 112 56 100 50 Q 86 56 76 52 Q 64 56 58 60 Z"
          fill="#1A1417"
          stroke="#1A1417"
          strokeWidth="2.5"
        />
        {/* cheeks */}
        <ellipse cx="72" cy="92" rx="9" ry="5" fill="url(#chibi-pink)" stroke="none" />
        <ellipse cx="128" cy="92" rx="9" ry="5" fill="url(#chibi-pink)" stroke="none" />
        {/* eyes */}
        <circle cx="80" cy="82" r="6.5" fill="#1A1417" stroke="none" />
        <circle cx="120" cy="82" r="6.5" fill="#1A1417" stroke="none" />
        <circle cx="82" cy="80" r="2" fill="#FBF1DD" stroke="none" />
        <circle cx="122" cy="80" r="2" fill="#FBF1DD" stroke="none" />
        {/* mouth */}
        {pose === 'sleep' ? (
          <g>
            <path d="M76 82 Q 80 86 84 82" strokeWidth="3" />
            <path d="M116 82 Q 120 86 124 82" strokeWidth="3" />
            <path d="M92 102 Q 100 108 108 102" strokeWidth="3" />
          </g>
        ) : (
          <path d="M88 100 Q 100 112 112 100" strokeWidth="3.5" />
        )}
      </svg>
    );
  }

  if (who === 'mochi') {
    return (
      <svg {...baseProps}>
        <defs>
          <pattern id="chibi-purp" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-15)">
            <circle cx="2" cy="2" r="1.2" fill="#7B3FE4" opacity="0.85" />
          </pattern>
        </defs>
        <path
          d="M60 138 Q 54 178 66 192 L 134 192 Q 146 178 140 138 L 120 132 L 100 138 L 80 132 Z"
          fill="#FBF1DD"
          strokeWidth="4"
        />
        <path d="M66 192 L 134 192" strokeWidth="4" />
        <path d="M60 138 Q 44 160 50 180" strokeWidth="4" />
        {pose === 'peace' ? (
          <g>
            <path d="M140 138 Q 154 124 156 100" strokeWidth="4" />
            <circle cx="160" cy="92" r="11" fill="#FBF1DD" strokeWidth="3.5" />
            <path d="M156 84 L 154 70 M164 84 L 166 70" strokeWidth="3" />
          </g>
        ) : (
          <path d="M140 138 Q 156 160 150 180" strokeWidth="4" />
        )}
        <circle cx="50" cy="184" r="9" fill="#FBF1DD" strokeWidth="3.5" />
        {pose !== 'peace' && <circle cx="150" cy="184" r="9" fill="#FBF1DD" strokeWidth="3.5" />}
        <circle cx="100" cy="80" r="48" fill="#FBF1DD" strokeWidth="4.5" />
        <path
          d="M54 76 Q 50 40 78 28 Q 100 20 124 28 Q 152 42 148 80 Q 144 70 138 70 L 132 90 L 128 72 L 120 88 L 116 72 L 108 90 L 104 70 L 96 88 L 92 70 L 84 86 L 80 70 L 72 86 L 68 72 L 60 80 Q 56 76 54 76 Z"
          fill="#1A1417"
          stroke="#1A1417"
          strokeWidth="2.5"
        />
        {/* headphones */}
        <path d="M52 78 Q 50 56 74 50" strokeWidth="4" />
        <ellipse cx="52" cy="86" rx="9" ry="13" fill="#FF4FA3" strokeWidth="4" />
        <ellipse cx="148" cy="86" rx="9" ry="13" fill="#FF4FA3" strokeWidth="4" />
        <path d="M148 78 Q 150 56 126 50" strokeWidth="4" />
        {/* eyes */}
        <path d="M76 96 Q 84 92 92 96" strokeWidth="3.5" />
        <path d="M108 96 Q 116 92 124 96" strokeWidth="3.5" />
        <ellipse cx="76" cy="108" rx="7" ry="4" fill="url(#chibi-purp)" stroke="none" />
        <ellipse cx="124" cy="108" rx="7" ry="4" fill="url(#chibi-purp)" stroke="none" />
        <path d="M94 114 Q 100 118 106 114" strokeWidth="3" />
      </svg>
    );
  }

  if (who === 'sprout') {
    return (
      <svg {...baseProps}>
        <path
          d="M70 142 Q 64 178 76 192 L 124 192 Q 136 178 130 142 L 116 138 L 100 142 L 84 138 Z"
          fill="#FF4FA3"
          strokeWidth="4"
        />
        <path d="M70 142 Q 56 152 50 170" strokeWidth="4" />
        <path d="M130 142 Q 144 152 150 170" strokeWidth="4" />
        <circle cx="50" cy="176" r="9" fill="#FBF1DD" strokeWidth="3.5" />
        <circle cx="150" cy="176" r="9" fill="#FBF1DD" strokeWidth="3.5" />
        <circle cx="100" cy="92" r="42" fill="#FBF1DD" strokeWidth="4.5" />
        <path d="M96 50 Q 96 32 100 28 Q 104 32 104 50" fill="#1A1417" stroke="#1A1417" strokeWidth="3" />
        <path d="M92 56 Q 88 50 88 42" strokeWidth="3" />
        <circle cx="86" cy="90" r="5" fill="#1A1417" stroke="none" />
        <circle cx="114" cy="90" r="5" fill="#1A1417" stroke="none" />
        <circle cx="88" cy="88" r="1.5" fill="#FBF1DD" stroke="none" />
        <circle cx="116" cy="88" r="1.5" fill="#FBF1DD" stroke="none" />
        <ellipse cx="78" cy="100" rx="6" ry="3.5" fill="#FF7A29" opacity="0.5" stroke="none" />
        <ellipse cx="122" cy="100" rx="6" ry="3.5" fill="#FF7A29" opacity="0.5" stroke="none" />
        <path d="M90 108 Q 100 118 110 108" strokeWidth="3" fill="#1A1417" />
        <path d="M90 108 Q 100 110 110 108" strokeWidth="2" stroke="#FBF1DD" />
      </svg>
    );
  }

  return null;
}

interface ChibiWithBubbleProps {
  who?: ChibiWho;
  pose?: ChibiPose;
  message: ReactNode;
  bubbleSide?: 'left' | 'right';
  size?: number;
  style?: CSSProperties;
}

export function ChibiWithBubble({
  who = 'pip',
  pose = 'wave',
  message,
  bubbleSide = 'right',
  size = 180,
  style,
}: ChibiWithBubbleProps) {
  return (
    <div style={{ position: 'relative', display: 'inline-block', ...style }}>
      <Chibi who={who} pose={pose} size={size} />
      <div
        style={{
          position: 'absolute',
          top: -10,
          [bubbleSide === 'right' ? 'left' : 'right']: size - 30,
          transform: `rotate(${bubbleSide === 'right' ? '-3deg' : '3deg'})`,
        }}
      >
        <SpeechBubble kind="cloud" side={bubbleSide === 'right' ? 'left' : 'right'} color="cream" small>
          {message}
        </SpeechBubble>
      </div>
    </div>
  );
}
