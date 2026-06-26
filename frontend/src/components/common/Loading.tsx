/**
 * Hand-drawn squiggle spinner — the pen draws and erases itself in a loop.
 */
export function Loading() {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg
        width="56"
        height="56"
        viewBox="0 0 64 64"
        fill="none"
        aria-label="loading"
        style={{ overflow: 'visible' }}
      >
        <circle
          cx="32"
          cy="32"
          r="24"
          stroke="var(--ink)"
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
          strokeDasharray="60 100"
          style={{
            transformOrigin: '32px 32px',
            animation: 'spin 1.2s linear infinite',
          }}
        />
        <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
      </svg>
    </div>
  );
}
