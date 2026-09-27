import { useEffect, type RefObject } from 'react';

/** What the room glows when nothing is playing: your lamp left, their seat right. */
const HOUSE = {
  left: 'rgb(96 58 30)',
  right: 'rgb(26 74 84)',
  centre: 'rgb(44 24 34)',
};

const SAMPLE_W = 24;
const SAMPLE_H = 14;
const SAMPLE_MS = 280;

/**
 * Ambient light for the stage: sample whatever is playing and throw its
 * colours onto the room around it — the left of the picture lights the left
 * wall, the right lights the right.
 *
 * Finds its source by attribute, `video[data-ambient]` inside `hostRef`, so
 * the stage can swap between a shared screen, a face and nothing at all
 * without anyone wiring a ref through. Writes three custom properties on the
 * host; CSS does the rest, and because they are registered colours
 * (tokens.css) the glow drifts between samples instead of stepping.
 *
 * Cheap on purpose: the frame is drawn into a 24×14 canvas (the GPU does the
 * downscale), read back, averaged — a few hundred pixels, under four times a
 * second, paused in background tabs. Nothing leaves the machine; the pixels
 * are never stored beyond the three averages.
 */
export function useAmbientLight(hostRef: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const setHouse = () => {
      host.style.setProperty('--amb-l', HOUSE.left);
      host.style.setProperty('--amb-r', HOUSE.right);
      host.style.setProperty('--amb-c', HOUSE.centre);
    };
    setHouse();
    if (!enabled) return;

    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    let timer = 0;
    let showingHouse = true;

    const sample = () => {
      const video = host.querySelector<HTMLVideoElement>('video[data-ambient]');
      // No picture, a picture not decoding yet, or one deliberately hidden
      // (camera off keeps the element mounted at opacity 0).
      if (
        !video ||
        video.readyState < 2 ||
        video.videoWidth === 0 ||
        getComputedStyle(video).opacity === '0'
      ) {
        if (!showingHouse) {
          setHouse();
          showingHouse = true;
        }
        return;
      }
      try {
        ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
        const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
        const third = Math.floor(SAMPLE_W / 3);
        host.style.setProperty('--amb-l', average(data, 0, third));
        host.style.setProperty('--amb-r', average(data, SAMPLE_W - third, SAMPLE_W));
        host.style.setProperty('--amb-c', average(data, third, SAMPLE_W - third));
        showingHouse = false;
      } catch {
        // A frame that cannot be read (a tainted source, a context lost to
        // the GPU) just leaves the last colours up.
      }
    };

    const start = () => {
      window.clearInterval(timer);
      if (!document.hidden) timer = window.setInterval(sample, SAMPLE_MS);
    };
    const onVisibility = () => start();

    sample();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hostRef, enabled]);
}

/**
 * Average a vertical band of the sample, then make it worth glowing: a raw
 * average of real footage is usually a muddy brown, so saturation is pushed
 * up and lightness kept in a band where it reads as light on a dark wall
 * rather than as a stain or a floodlight.
 */
function average(data: Uint8ClampedArray, x0: number, x1: number): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < SAMPLE_H; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * SAMPLE_W + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  const [h, s, l] = rgbToHsl(r / n, g / n, b / n);
  const [rr, gg, bb] = hslToRgb(h, Math.min(1, s * 1.45 + 0.08), clamp(l, 0.22, 0.52));
  return `rgb(${rr} ${gg} ${bb})`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}
