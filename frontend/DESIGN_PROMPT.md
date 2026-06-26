# WatchTogether — Colored Manga Sketchbook Redesign

## The Product
WatchTogether is a peer-to-peer video calling app for 2 people. You log in, create or join a session via invite link, and get a side-by-side video call with screen-sharing, a chat panel, and media controls (mute, camera off, leave, etc.). It's intimate — one friend talking to one friend — so the visual language should feel personal, expressive, and a little dramatic, like a slice-of-life manga where small moments are framed with the same care as huge ones.

## Aesthetic Direction: "Colored Manga Sketchbook" (Chainsaw Man energy)

The vibe is **Tatsuki Fujimoto's Chainsaw Man** — but colored, and applied to a video-chat UI. Adjacent references: **Fire Punch**, **Goodbye Eri**, **Inio Asano** (Solanin / Goodnight Punpun for atmospheric panels), the color pages of **Akira**, and **Junji Ito** for the rougher pen energy (without the horror).

Concretely:

- **Confident, slightly rough ink linework.** Strokes are **2–4px**, with the wobble and confidence of a manga pen nib (not a digital perfect line). Use SVG paths with subtle imperfections — `stroke-linecap="round"`, slight overshoots at corners.
- **Heavy black fills.** This is the signature Fujimoto move — large solid-black shapes for shadow, drama, and silhouettes. Apply to: shadowed sides of buttons, hair/silhouette areas of avatar placeholders, dramatic backgrounds during transitions.
- **Screentone — the structural texture.** Instead of decorative halftone dots, use **screentone patterns** (dots, parallel lines, crosshatch, gradient dots) as the *primary shading mechanism*. In our colored version:
  - **Pink screentone** = standard shading on cream surfaces (the "default tone")
  - **Purple screentone** = intensity, emphasis, hover/focus shading
  - **Orange screentone** = alerts, alarms, "loud" moments
  - Vary density: tight dots for shadows, sparse dots for soft shading, parallel lines for motion/speed surfaces.
- **High contrast.** Don't shy away from huge solid-black areas next to bright pink or cream — the contrast IS the style. No muddy grays.
- **Cream paper background** — slightly warm off-white, with very faint paper grain. Occasional ruled lines or grid faintly visible (like a school notebook), as if the whole UI is sketched in someone's journal.
- **Comic panel layouts** with **bold ink borders** (3–5px), slight irregular rotation (±1–3°). Borders should occasionally have a tiny gap or wobble — not perfect rectangles.
- **Panel breaking.** Manga's most dynamic trick: let elements *bleed outside their panel borders* during dramatic moments. A character's reaction floats outside its card. A SFX punches through a frame. A speech bubble overlaps two panels. Use sparingly — for big moments only (someone joins, message arrives, error explodes).
- **Manga-style speech bubbles** — emotion through shape:
  - **Oval bubble, smooth outline** = normal speech / chat message
  - **Jagged spike-burst outline** = shouting, errors, urgent alerts
  - **Cloud bubble** = system thoughts, hints, tooltips
  - **Rectangular box, ruled border** = narration / system messages ("Friend connected.")
  - Tails are short, sharp triangles — not the soft western curve.
- **Sound effects as typography.** Big, bold, integrated SFX text styled like Chainsaw Man's English-localized SFX — **"DING!"** when a message arrives, **"WHRR"** for camera toggling, **"TAP"** for button presses, **"KLIK"** for mute. These overlay the UI briefly and fade, slightly tilted, with ink-black fill and a colored screentone shadow.
- **Sketchbook annotations** — pencil-style arrows, circled words, "← psst" margin notes in handwriting, occasional crossed-out sketches as if the designer changed their mind. Subtle, scattered.
- **Slight rotation everywhere.** Buttons, cards, avatars, stickers — almost everything sits at ±1–3° rotation, as if hand-placed. Snap to true 0° on focus/hover for that "now it's the focus" punctuation.

**Sketchiness level: 3 / 5** — visibly hand-drawn, lines have personality, but every element is UI-legible and the layout reads cleanly. Wobble is in the details, not the structure.

## Color Palette (strict, semantic roles)

| Color | Hex | Role in a Colored Manga World |
|---|---|---|
| **Ink Black** | `#1A1417` | Outlines, text, **heavy black fills** — the pen and the shadow |
| **Cream** | `#FBF1DD` | Page / surface background — the manga newsprint paper |
| **Hot Pink** | `#FF4FA3` | Primary actions, **standard screentone color**, "yes do it" moments |
| **Sunset Orange** | `#FF7A29` | Warnings, destructive actions, **loud SFX color**, live indicators |
| **Royal Purple** | `#7B3FE4` | Secondary actions, **emphasis screentone**, magical/special moments |

Rules:
- **Black ink is sacred** — every interactive element has an ink outline. No floaty borderless buttons.
- **Cream is the canvas** — most surfaces are cream. Pure white is forbidden.
- **Pink for "yes"** — primary buttons, send, join, accept. Also default screentone shading.
- **Orange for "wait" / "loud"** — destructive actions (leave call, end session), errors, mic-on indicators, big SFX bursts.
- **Purple for delight** — invitations, admin features, hover surprises, "intensity" screentone for emphasized states.
- Combine pink + purple gradient screentones sparingly for "premium / magic" moments (successful invite sent, friend just joined).

## Typography

- **Display / SFX** — **Bowlby One**, **Sigmar**, or **Bangers** (Bangers is the safest manga-SFX feel). Use for headings, big SFX, button labels.
- **Body** — **M PLUS Rounded 1c** (subtle Japanese typography feel) or **Quicksand** (warmer Western fallback). Use for chat text, paragraphs, inputs.
- **Margin annotations / handwriting** — **Caveat** or **Shadows Into Light** for the "scribbled note" feel.
- **Numerals** — slightly heavier weight than body, treated like manga sound-effect numbers.

## Animation Direction: Maximalist, Bouncy, Dramatic

Use **Framer Motion**. Energy target: a slice-of-life manga where moments are over-dramatized for emotional effect. Apps like Duolingo and Headspace are the closest mainstream reference for motion vibe.

**Animation principles:**
- **Spring physics, not linear easing.** Bouncy, slightly over-shooting, settling.
- **Manga impact frames** — on important moments, briefly flash a high-contrast frame: black silhouette against cream, then snap back. Examples: friend joins, message sent, leave-call confirmed. ~150ms flash.
- **Speed lines** radiating from elements during action — appear on send, mute toggle, join.
- **Screen shake** — full-viewport shake for big moments (only for: friend joining, dramatic errors). ±4px, 200ms, 3 oscillations.

**Required animations:**

### Page transitions
- Routes transition with a **page-turn**, plus a brief **manga impact-frame flash** between pages.
- Initial load: elements **sketch in line-by-line** with `strokeDashoffset` animation (the pen draws live).

### Buttons
- Hover: **wiggle** (±3° rotation jelly spring), **scale 1.05**, screentone shadow grows, tiny ✨ doodles spark beside it.
- Click: **squash down** (scale 0.95 → 1.0 with overshoot), spawn a small "TAP" or "KLIK" SFX that floats up and fades.
- Idle: subtle **breathing** scale (1.0 → 1.02 → 1.0 over 4s) on the primary CTA.

### Cards / panels
- Mount: **drop in from above with overshoot bounce** and a small rotation that settles to the resting tilt.
- Hover: **lift** (translateY -4px) and ink shadow offsets diagonally — like peeling off the page.
- Panel border has a subtle **"ink wet → dry" animation** on mount: starts darker/glossier, dries to flat black.

### Inputs
- Focus: outline **wobbles once**, screentone shading shifts from pink → purple.
- Invalid: **shake horizontally** (5x, ±8px) + jagged red-orange spike-bubble pops above with "OOPS!"

### Chat (speech bubbles)
- New oval bubble: **pops in with overshoot** (scale 0 → 1.15 → 1.0), tail draws in with 100ms delay.
- Sending: message **flies out of input** along an arc into the chat history.
- Long messages: bubble **scales open vertically** as if inhaling.
- Reaction emojis pop with a small star-burst behind them.

### Toasts / notifications
- Slide in from corner as **comic-burst stickers** (jagged spike-bubbles), wobble on landing.
- Success: pink burst + 3–5 confetti squiggles fall and fade.
- Error: orange jagged burst with "OOPS!" text, halftone flashes orange, slight viewport shake.

### Session room (the call)
- Friend joins: **massive "CONNECTED!" manga impact frame** explodes from center — black silhouette, speed lines radiating outward, then shrinks into a small badge in the corner. ~600ms total.
- Camera toggle: video tile **flips like a manga panel page** (back is a doodled chibi avatar with "Z z z" thought bubbles if cam is off).
- Screen share start: a thick highlighter line **draws a frame** around the shared screen, "FEATURE PRESENTATION" SFX overlays briefly.
- Mute/unmute: mic icon **morphs** (SVG path morph). On mute, a small jagged "SHH!" bubble appears beside the user's tile and fades.
- Speaking indicator: speaker's panel border **pulses orange screentone**, like ink bleeding outward on each syllable.

### Decorative idle motion
- Background paper texture drifts slowly (parallax).
- **Floating doodles** in empty corners (stars, hearts, squiggles) bob with offset timing.
- Every 8s, a faint **screentone dot wave** sweeps across the page — like the page is "breathing."
- Occasional very subtle **margin doodle** appears in a corner with a sketch-in animation (e.g., a tiny tv, popcorn, heart), then fades after 10s.

### Loading states
- Spinner is a **hand-drawn squiggle** that draws and erases itself in a loop.
- Empty states feature a **chibi character** waving (e.g., empty chat: a tiny doodle character holding a sign that says "say hi!" with wobbling animation).

**Animation rules:**
- **During an active video call**, dial down ambient motion — paper drift stops, idle doodles pause. Reactions, toasts, chat, and impact-frames stay. The video is the star.
- Respect `prefers-reduced-motion` — fall back to opacity-only fades.

## Screen-by-Screen Direction

### Login / Register / Invite Signup
- The form sits on a **sketchbook page** — visible spiral binding on the left, slight page curl on the corner.
- Heading "WatchTogether" in big hand-lettered display font, with a doodled underline that draws in.
- Inputs are **ink-outlined boxes** (no fills) on cream paper. Placeholder text is in handwriting.
- "Sign In" button: hot pink sticker with **pink screentone shading on the bottom-right** and a hard ink shadow, slightly rotated.
- Margin doodles: floating tv/popcorn/heart icons, handwritten "watch with friends ♥" in the margins.
- A small chibi character peeks from the bottom corner.

### Email Verification / Check Email
- Giant **manga-style envelope** with a wax seal that wobbles. On verification, seal cracks with a "TADA!" impact frame.

### Lobby
- Sketchbook page with the user's name handwritten at the top ("hey, kutay!").
- Primary action: huge pink sticker button **"CREATE A SESSION"** with a manga starburst behind it and speed lines radiating.
- Invitation slots shown as **stamp marks** on a "ticket page" — three little tear-off ticket stubs, used ones crossed out in pen, available ones glow with pink screentone.
- Admin link (if root): tiny "🔑 secret door" doodle in the bottom corner that wiggles on hover and briefly shows a purple screentone glow.
- Logout: handwritten "bye 👋" link.

### Session Room (the call) — Full Comic Frame
- Video grid = **two manga panels side by side**, separated by a thick black gutter (5–8px).
- Each panel has a **bold black ink frame** (4px), slight rotation (one ~+2°, the other ~-2°), with a name plate on the bottom-left styled like a manga character introduction box (small ruled rectangle, name in display font).
- **Speaker indicator**: active speaker's panel border **pulses with orange screentone bleeding inward** like ink soaking the paper. Subtle but readable.
- **Panel breaking on big moments**: friend's reaction (mute/unmute, camera toggle) briefly bleeds outside the panel border as a SFX bubble.
- **Screen share**: replaces the grid with one giant panel, framed like a "FEATURE PRESENTATION!" manga page — thick ink border, "CHAPTER START" style ribbon in the corner.
- **Media controls** at the bottom: a row of **sticker buttons** (mic, camera, screen share, leave). Each is an ink-outlined rounded sticker with screentone shadow. Leave button is bright orange, slightly bigger, with a jagged "BYE!" bubble on hover.

### Chat Panel (right side)
- A vertical strip styled like **the right page of an open manga** — bound on the left edge.
- Messages are **oval speech bubbles** flowing top-to-bottom.
- Your messages: pink-filled bubble, tail on the right, your handle in small handwriting above.
- Friend's messages: cream bubble with purple ink outline, tail on the left, their handle above.
- Urgent/system messages: rectangular **narration boxes** with ruled borders.
- Input at the bottom: a **thought-bubble-shaped** input. Send button is a small pink airplane sticker that takes off with a "SWOOSH" SFX when pressed.

### Invite Modal
- Pops in as a **postcard floating from off-screen**, lands with a bounce, stays tilted.
- Invite link sits on a **dotted-line tear-off ticket** with "✂ cut here" doodle.
- "Send" button is a pink "MAIL IT!" stamp that thuds down with a "STAMP!" SFX on click.

### Admin Dashboard
- The "VIP backroom" — purple-screentone tinted background, denser ink work, slightly more "shadowy."
- User tree displayed as a **hand-drawn family tree** with sketched branches connecting nodes.
- Tables styled like **ledger pages** with ruled lines and corner page-numbers.

### Toasts / Notifications
- Slide in from top-right as comic-burst stickers (jagged spike-bubbles).
- Success: pink star-burst + small confetti squiggles falling.
- Error: orange jagged burst with "OOPS!" lettering, mini viewport shake.
- Info: cream rectangular narration box.

### Browser Warning
- A worried chibi character pointing at the warning text. Handwritten "psst — try Chrome for the best experience" copy. Slight wiggle on the character.

## Technical Notes

- **Stack stays the same**: React 19 + TypeScript + Vite + Tailwind CSS 4. Add **framer-motion**.
- **Fonts**: Load **Bangers** + **M PLUS Rounded 1c** + **Caveat** from Google Fonts.
- **SVG everywhere**: inline SVGs for outlines, screentone patterns, doodles, burst shapes, SFX, chibi characters. Animatable.
- **Screentone patterns**: implement as repeatable SVG `<pattern>` elements — pink dots, purple dots, orange dots, parallel lines, crosshatch. Apply as fills.
- **Paper texture**: subtle cream paper SVG tiled as body background. Keep file small.
- **Tailwind config**: extend the theme with named tokens (`ink`, `cream`, `pink`, `orange`, `purple`) and custom utilities for screentone fills.
- **Accessibility**: maintain WCAG AA contrast on text. Body text is always ink-on-cream (~14:1). Pink/orange used only for buttons-with-ink-outlines or ≥18pt headings.
- **No functionality changes**: routes, API, WebRTC, SignalR signaling, session logic all stay. **Pure visual + interaction redesign.**

## Deliverables

1. Redesigned versions of every screen listed above.
2. A **component library page** showing reusable building blocks: sticker buttons (3 color variants), speech bubbles (4 shape variants — oval / spike / cloud / rectangle), comic panel, input, toast, screentone patterns, doodle decorations, chibi character set.
3. The **Framer Motion variants** used (page-turn, impact-frame flash, panel-break, sticker-bounce, jagged-pop), exported as reusable presets.
4. A short **README** documenting color tokens, font choices, animation timing constants, and the screentone pattern catalog.

Make it feel like **a Chainsaw Man chapter where two friends are just hanging out on a video call** — same expressive linework, same dramatic energy, but the subject matter is intimate and warm, not violent. Be brave with the contrast and the panel-breaking. The whimsy lives in the *moments*, not the layout.
