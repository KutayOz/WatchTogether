import { useEffect, useId, useState } from 'react';
import { NotebookField } from '../manga';
import { evaluatePassword, type PasswordEvaluation } from '../../utils/validation';
import { loadZxcvbn } from '../../utils/zxcvbnLoader';

interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Show the live "at least 12 chars / one uppercase / …" rule list. */
  showChecklist?: boolean;
  /** Show the zxcvbn-based strength bar. */
  showStrengthMeter?: boolean;
  /** Show the "show / hide" reveal toggle. Default true. */
  showToggle?: boolean;
  /**
   * Fired with the current rule evaluation whenever the password changes.
   * Parent forms use this to gate the submit button without re-deriving.
   */
  onEvaluation?: (evaluation: PasswordEvaluation) => void;
}

/**
 * Manga-styled password input with three integrated UX affordances:
 *
 *   1. Hand-written "show / hide" toggle (right-adornment in the ruled line)
 *   2. Live rule checklist (one row per backend constraint)
 *   3. zxcvbn strength bar (4 segments, orange→pink→purple)
 *
 * The checklist mirrors PasswordValidator.cs on the backend exactly. The
 * strength bar is purely advisory — it does NOT gate submit (a weak-but-
 * rule-passing password still goes through and the server makes the call,
 * including its HIBP check).
 *
 * Bundle note: zxcvbn-ts is loaded async on first render and the bar
 * fades in once the score arrives. Until then nothing flashes — we'd
 * rather feel slightly slow than wrong.
 */
export function PasswordField({
  value,
  onChange,
  label = 'password:',
  placeholder,
  required,
  autoFocus,
  disabled,
  showChecklist = true,
  showStrengthMeter = true,
  showToggle = true,
  onEvaluation,
}: PasswordFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState<0 | 1 | 2 | 3 | 4 | null>(null);
  const checklistId = useId();

  const evaluation = evaluatePassword(value);

  // Notify parent of validity changes. We only fire when the rule-state
  // actually changes — passing the full evaluation each render would
  // cause re-renders to cascade.
  useEffect(() => {
    onEvaluation?.(evaluation);
    // We *want* this to re-fire on rule-state change, not object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation.valid, evaluation.errors.join('|')]);

  // zxcvbn evaluation — debounced 220ms so we don't thrash on every keystroke.
  useEffect(() => {
    if (!showStrengthMeter) return;
    if (!value) {
      setScore(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      loadZxcvbn().then((zxcvbn) => {
        if (cancelled) return;
        setScore(zxcvbn(value).score);
      });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [value, showStrengthMeter]);

  const toggle = showToggle ? (
    <button
      type="button"
      onClick={() => setRevealed((r) => !r)}
      aria-pressed={revealed}
      aria-label={revealed ? 'Hide password' : 'Show password'}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        padding: '2px 6px',
        fontFamily: 'var(--font-hand)',
        fontWeight: 600,
        fontSize: 20,
        color: 'var(--purple)',
        textDecoration: 'underline',
        textDecorationStyle: 'dashed',
        textUnderlineOffset: 3,
        opacity: disabled ? 0.5 : 1,
        transform: 'rotate(-1deg)',
      }}
    >
      {revealed ? 'hide' : 'show'}
    </button>
  ) : null;

  return (
    <div>
      <NotebookField
        label={label}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete={label.toLowerCase().includes('new') ? 'new-password' : 'current-password'}
        aria-describedby={showChecklist ? checklistId : undefined}
        rightAdornment={toggle}
      />

      {showStrengthMeter && value && score !== null && (
        <StrengthMeter score={score} />
      )}

      {showChecklist && value && (
        <ul
          id={checklistId}
          className="hand"
          aria-live="polite"
          style={{
            listStyle: 'none',
            margin: '8px 0 0 0',
            padding: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '2px 16px',
            fontSize: 18,
          }}
        >
          {evaluation.rules.map((rule) => (
            <li
              key={rule.id}
              style={{
                color: rule.passed ? 'var(--purple)' : 'rgba(26,20,23,0.55)',
                transition: 'color 160ms ease',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 18,
                  textAlign: 'center',
                  color: rule.passed ? 'var(--purple)' : 'var(--orange-deep, var(--orange))',
                  fontWeight: 700,
                }}
              >
                {rule.passed ? '✓' : '·'}
              </span>
              <span>
                {rule.label}
                <span className="sr-only">
                  {rule.passed ? ' (met)' : ' (not yet)'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Strength meter — 4 segments, Chainsaw Man palette              */
/* Palette mapping is deliberate:                                 */
/*   0 fragile   → orange         (alarm)                         */
/*   1 weak      → orange         (alarm, fading)                 */
/*   2 okay      → pink           ("yes, but…")                   */
/*   3 strong    → pink + purple                                  */
/*   4 fortress  → purple         (delight)                       */
/* ────────────────────────────────────────────────────────────── */

const STRENGTH_LABELS = ['fragile', 'weak', 'okay', 'strong', 'fortress'] as const;
const STRENGTH_COLORS = [
  'var(--orange)',
  'var(--orange)',
  'var(--pink)',
  'var(--pink)',
  'var(--purple)',
] as const;

function StrengthMeter({ score }: { score: 0 | 1 | 2 | 3 | 4 }) {
  const color = STRENGTH_COLORS[score];
  return (
    <div
      style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={4}
      aria-valuenow={score}
      aria-valuetext={STRENGTH_LABELS[score]}
    >
      <div style={{ display: 'flex', gap: 4, flex: 1 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 8,
              borderRadius: 2,
              background: i < score ? color : 'rgba(26,20,23,0.08)',
              border: '1px solid rgba(26,20,23,0.18)',
              transition: 'background 200ms ease',
              transform: `rotate(${i % 2 === 0 ? -0.4 : 0.4}deg)`,
            }}
          />
        ))}
      </div>
      <span
        className="hand"
        style={{
          fontSize: 18,
          fontWeight: 700,
          color,
          minWidth: 80,
          textAlign: 'right',
          transform: 'rotate(-2deg)',
        }}
      >
        {STRENGTH_LABELS[score]}
      </span>
    </div>
  );
}
