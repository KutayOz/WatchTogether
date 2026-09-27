# WatchTogether — design

A private screening room for two. The room is dark velvet; the light in it
comes from the two people and the screen between them.

## The one idea: two lights

| Token | Value | Means |
|---|---|---|
| `--amber` | `#ffb547` | **You.** Your messages, your actions, the primary button. |
| `--teal` | `#5ad4e6` | **Them.** Their messages, their cursor, their voice glow. |
| `--light-screen` | `#fff3ec` | **Together.** Amber screen-blended over teal gives exactly this. |
| `--exit` / `--exit-fill` | `#ff5a6e` / `#d12f47` | Leave, delete, errors. The exit sign. |
| `--velvet-900…950` | `#150a10…#0c0609` | The room. Garnet, not grey. |

The mark (`ui/Lights.tsx`) is the whole system in one glyph: two circles
blended with `screen`. In a call it is apart — a dashed empty seat — until the
other person connects, then the lights slide together.

Text is `--text-1…4`; every pair used for body text clears WCAG AA on the
surfaces it sits on (`--text-4` is the floor, ≈4.9:1 on `--velvet-800`).

## Type

- **Caprasimo** — titles only. A soft, heavy seventies title-card serif.
- **Atkinson Hyperlegible Next** — everything read fast, including labels drawn
  over live video.
- **Atkinson Hyperlegible Mono** — only for things copied by hand: invite and
  reset links, the debug report.

Display sizes are fluid (`--t-3xl…5xl`); titles projected on a screen are sized
in container units off that screen, not off the window.

## Motion

Two kinds, and nothing else (`ui/motion.ts`):

- **Springs** for anything answering a person — opening, pressing, dragging.
- **The focus pull** for things arriving: soft and slightly large, settling
  sharp, like a projectionist finding focus.

What runs in JavaScript, and where:

| Effect | Where | How |
|---|---|---|
| Projector light | Sign-in screens, lobby | `ui/Projector.tsx` — canvas, half resolution, 30 fps, paused off-screen. Your light follows the cursor. |
| Dust in the beam | Sign-in screens | `ui/DustMotes.tsx` — canvas; motes are lit only inside the CSS beam's cone. |
| Ambient light | Call stage, device check | `hooks/useAmbientLight.ts` — samples `video[data-ambient]` into a 24×14 canvas ~4×/s; three registered colour properties the CSS glow transitions between. |
| Voice glow | Tiles, stage, preview | `hooks/useAudioLevel.ts` — one shared AudioContext, `--level` written straight to style. |
| Mic oscilloscope | Device check | `PreflightLobby.tsx` `MicWaveform` — canvas, no React renders. |
| Pointer light, magnetic buttons, ripples, tilt | Everywhere, by attribute | `ui/interactions.ts` — four delegated listeners: `[data-light]`, `[data-magnetic]`, `[data-ripple]`, `[data-tilt]`. |
| Film leader | Joining a call | `ui/FilmLeader.tsx` — one rAF clock drives sweep and number. |
| Self view | Call stage | `ScreenShareView.tsx` `SelfView` — pointer drag, FLIP glide to the nearest corner, remembered. |
| Reactions | Call | WAAPI flight path generated per reaction id. |

Motion uses `m.*` components under `LazyMotion strict` (`ui/MotionRoot.tsx`);
a stray `motion.div` throws.

**Reduced motion** is honoured everywhere: motion stops transforms, a CSS rule
drops the focus-pull blurs, canvases draw one still frame, and the interaction
layer stops leaning and rippling. `e2e/motion.spec.ts` checks both states.

## Layout

- **Theater** (`ui/Theater.tsx`) — every signed-out screen: a screen at the
  top with the page's title card projected on it, the single sheet below in
  its light.
- **App shell** (`ui/AppShell.tsx`) — lobby, settings, admin.
- **Room** (`Session/session.css`) — stage, dock, side panel. The side panel is
  docked and resizable at ≥1024px, a drawer from the right on a tablet, a
  sheet from the bottom on a phone; `inert` while closed.

Radii follow what a thing is: screens 20px, sheets 26px, cards 16px, fields
12px, controls are capsules.

## Components

`ui/`: `Button`, `IconButton`, `TextField`/`TextArea`, `Segmented` (real
radios), `Modal` (focus trap; a bottom sheet with swipe-down on phones),
`Popover`, `Toast` (`common/Toast.tsx`, pauses on hover, swipe to dismiss),
`FocusText`, `ScrambleText`, `Lights`, `Projector`, `DustMotes`,
`FilmLeader`, `icons`.

Screen styles live next to their screens and ship in that screen's chunk;
shared styles are in `src/styles/`.
