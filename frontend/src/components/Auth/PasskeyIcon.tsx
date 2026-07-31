/** The padlock-with-key glyph, shared by the sign-in and signup screens. */
export function PasskeyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 1a4 4 0 014 4v3h1a3 3 0 013 3v9a3 3 0 01-3 3H7a3 3 0 01-3-3v-9a3 3 0 013-3h1V5a4 4 0 014-4zm0 2a2 2 0 00-2 2v3h4V5a2 2 0 00-2-2zm0 11a2 2 0 100 4 2 2 0 000-4z"
        fill="currentColor"
      />
    </svg>
  );
}
