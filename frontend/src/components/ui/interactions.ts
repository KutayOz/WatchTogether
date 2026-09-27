/**
 * The interaction layer: pointer light, magnetic controls, press ripples and
 * card tilt, for the whole app, from four delegated listeners on the document.
 *
 * Opt-in by attribute rather than by component:
 *
 *   [data-light]     a soft amber pool follows the cursor across the element
 *   [data-magnetic]  the element leans a few pixels toward the cursor
 *   [data-ripple]    pressing it throws a ring of light from the press point
 *   [data-tilt]      the element tips toward the cursor in 3D
 *
 * Why delegated and imperative instead of a hook per component: these effects
 * run on every pointermove, and routing that through React state would
 * re-render whatever is under the cursor sixty times a second. Here a move
 * costs one rAF-coalesced style write on one element, and a component opts in
 * by adding an attribute — nothing to mount, nothing to clean up.
 *
 * Mouse only. On touch there is no hover to answer, and a magnetic button that
 * slides out from under a finger is a bug, not a flourish. Everything here also
 * stands down under prefers-reduced-motion except the light, which does not
 * move anything.
 */

let installed = false;

const MAG_X = 9;
const MAG_Y = 7;
const MAG_PULL = 0.28;
const TILT_DEG = 7;

export function installInteractions(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  let lastEvent: PointerEvent | null = null;
  let raf = 0;
  let lit: HTMLElement | null = null;
  let magnet: HTMLElement | null = null;
  let tilted: HTMLElement | null = null;
  /** The magnet's resting centre, so its own offset cannot feed back into the pull. */
  const restCentre = new WeakMap<HTMLElement, { x: number; y: number }>();

  const isDisabled = (el: HTMLElement) =>
    (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

  const releaseMagnet = (el: HTMLElement) => {
    el.removeAttribute('data-mag-active');
    el.style.translate = '';
    restCentre.delete(el);
  };

  const releaseTilt = (el: HTMLElement) => {
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.removeAttribute('data-tilting');
  };

  const frame = () => {
    raf = 0;
    const e = lastEvent;
    if (!e) return;
    const target = e.target instanceof Element ? e.target : null;

    // ── light ───────────────────────────────────────────────────────────
    const lightEl = (target?.closest('[data-light]') as HTMLElement | null) ?? null;
    if (lightEl !== lit) {
      lit?.removeAttribute('data-lit');
      lit = lightEl;
      lit?.setAttribute('data-lit', '');
    }
    if (lit) {
      const r = lit.getBoundingClientRect();
      lit.style.setProperty('--px', `${e.clientX - r.left}px`);
      lit.style.setProperty('--py', `${e.clientY - r.top}px`);
    }

    if (reduce.matches) return;

    // ── magnet ──────────────────────────────────────────────────────────
    const magEl = (target?.closest('[data-magnetic]') as HTMLElement | null) ?? null;
    if (magEl !== magnet) {
      if (magnet) releaseMagnet(magnet);
      magnet = magEl && !isDisabled(magEl) ? magEl : null;
      if (magnet) {
        const r = magnet.getBoundingClientRect();
        restCentre.set(magnet, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
        magnet.setAttribute('data-mag-active', '');
      }
    }
    if (magnet) {
      const c = restCentre.get(magnet);
      if (c) {
        const dx = clamp((e.clientX - c.x) * MAG_PULL, -MAG_X, MAG_X);
        const dy = clamp((e.clientY - c.y) * MAG_PULL, -MAG_Y, MAG_Y);
        magnet.style.translate = `${dx.toFixed(2)}px ${dy.toFixed(2)}px`;
      }
    }

    // ── tilt ────────────────────────────────────────────────────────────
    const tiltEl = (target?.closest('[data-tilt]') as HTMLElement | null) ?? null;
    if (tiltEl !== tilted) {
      if (tilted) releaseTilt(tilted);
      tilted = tiltEl;
      tilted?.setAttribute('data-tilting', '');
    }
    if (tilted) {
      const r = tilted.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      tilted.style.setProperty('--ry', `${(nx * TILT_DEG * 2).toFixed(2)}deg`);
      tilted.style.setProperty('--rx', `${(-ny * TILT_DEG * 2).toFixed(2)}deg`);
    }
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    lastEvent = e;
    if (!raf) raf = requestAnimationFrame(frame);
  };

  // The pointer leaving the window fires no move over anything, so the last
  // element would stay lit and leaning forever without this.
  const onOut = (e: PointerEvent) => {
    if (e.relatedTarget) return;
    lastEvent = null;
    lit?.removeAttribute('data-lit');
    lit = null;
    if (magnet) releaseMagnet(magnet);
    magnet = null;
    if (tilted) releaseTilt(tilted);
    tilted = null;
  };

  const onDown = (e: PointerEvent) => {
    if (reduce.matches) return;
    const target = e.target instanceof Element ? e.target : null;
    const host = target?.closest('[data-ripple]') as HTMLElement | null;
    if (!host || isDisabled(host)) return;
    spawnRipple(host, e.clientX, e.clientY);
  };

  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
  document.addEventListener('pointerdown', onDown, { passive: true });
}

/**
 * A ring of light from the press point. Built outside React on purpose: it
 * lives for 650ms, belongs to no state, and is removed by its own animation.
 * The layer is appended last, after every child React manages, so React's own
 * insertBefore calls never see it.
 */
export function spawnRipple(host: HTMLElement, clientX: number, clientY: number): void {
  const r = host.getBoundingClientRect();
  const layer = document.createElement('span');
  layer.className = 'ripple-layer';
  layer.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.left = `${clientX - r.left}px`;
  dot.style.top = `${clientY - r.top}px`;
  layer.appendChild(dot);
  host.appendChild(layer);

  const reach = (Math.hypot(r.width, r.height) / 6) * 1.1;
  const anim = dot.animate(
    [
      { transform: 'scale(0)', opacity: 0.95 },
      { transform: `scale(${reach})`, opacity: 0 },
    ],
    { duration: 650, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
  const cleanup = () => layer.remove();
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
}

/**
 * Shake an element sideways — the one gesture for "that did not work".
 * WAAPI rather than a CSS class so it can replay on every failure without a
 * remove-and-re-add dance to restart the keyframes.
 */
export function shake(el: Element | null | undefined): void {
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-9px)' },
      { transform: 'translateX(8px)' },
      { transform: 'translateX(-6px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(-2px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 480, easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)' },
  );
}

/**
 * A little burst of sparks from an element — for moments that succeeded:
 * a link copied, an invite made. Pure WAAPI on throwaway nodes.
 */
export function sparkle(el: Element | null | undefined, tone: 'amber' | 'teal' = 'amber'): void {
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const colour = tone === 'amber' ? '255 181 71' : '90 212 230';
  // Whatever is fullscreen is the only thing the browser paints, so the sparks
  // have to live inside it or they fire unseen.
  const host = document.fullscreenElement ?? document.body;
  const count = 14;
  for (let i = 0; i < count; i++) {
    const spark = document.createElement('span');
    spark.setAttribute('aria-hidden', 'true');
    const size = 3 + Math.random() * 4;
    Object.assign(spark.style, {
      position: 'fixed',
      left: `${cx}px`,
      top: `${cy}px`,
      width: `${size}px`,
      height: `${size}px`,
      margin: `${-size / 2}px 0 0 ${-size / 2}px`,
      borderRadius: '50%',
      background: `rgb(${colour})`,
      boxShadow: `0 0 10px rgb(${colour} / 0.9)`,
      pointerEvents: 'none',
      zIndex: '500',
    } satisfies Partial<CSSStyleDeclaration>);
    host.appendChild(spark);
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = Math.max(r.width, r.height) * 0.45 + 24 + Math.random() * 38;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const anim = spark.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy + 10}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: 620 + Math.random() * 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    const cleanup = () => spark.remove();
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
