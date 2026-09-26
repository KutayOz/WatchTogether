# Independent streaming-quality package

This branch contains the streaming engine fixes independently of the pending UI redesign.
The engine runs in the browser; there are no Worker/backend, database migration,
API, signaling-schema or deployment-workflow changes.

## Changes

- Limit Auto to 1080p and allow approximately 6 Mbps for 1080p24 film instead of the previous 2.49 Mbps cap.
- Prefer H.264, retain codec fallbacks, and separate capture inactivity from encoder overload.
- Use one bandwidth controller, confirm recovery probes, and restore quality after transient CPU pressure.
- Apply actual sender resolution scaling and serialize parameter/capture updates across source switches and share restarts.
- Measure the screen track independently of the camera; detect a frozen stream even when no packets arrive.
- Associate diagnostics with the selected ICE path and acknowledged encoder settings.

Explicit High keeps its 1080p ceiling when the viewer resizes their window. Film requests 24 fps;
Motion requests 30 fps. Bitrates are encoder ceilings, not guaranteed network consumption.

## Validation on this isolated branch

- Frontend unit/hook suite: 436 tests passed.
- Production frontend build: passed.
- Native Chromium two-peer media suite: 2 tests passed, 1080p24/30 with zero dropped frames. Run with `cd frontend && npm run e2e:media`.
  It checks 1080p24/30, microphone/camera/screen soundtrack coexistence, ICE restart,
  live bitrate changes, 1080→720→1080 recovery, and share stop/start.

The browser media tests use a synthetic moving source and local ICE. They do not establish
WAN/TURN performance or perceptual quality on the users' actual movie and hardware.

## Release isolation

Base: `e6f8d24bb733a51f9ebb456a5b022fd57f6a8405`.
Branch: `codex/streaming-quality`.

The repository's production workflow triggers on pushes to `main` or manual dispatch.
This feature-branch push does not match that trigger. No merge or deploy is included
in this packaging operation. Review and release separately after the active session.
