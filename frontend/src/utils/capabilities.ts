/**
 * Whether this browser can share a screen at all.
 *
 * Phones cannot — neither iOS Safari nor Android Chrome implements
 * getDisplayMedia — and a share button that can only throw is worse than no
 * button. Checked with `in` because the DOM typings declare the method as
 * always present, which is exactly the assumption that is false on a phone.
 */
export function canCaptureScreen(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    'getDisplayMedia' in navigator.mediaDevices
  );
}
