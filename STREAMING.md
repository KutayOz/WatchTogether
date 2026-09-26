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

- Frontend unit/hook suite after the capture-recovery follow-up: 443 tests passed (including 7 new recovery regressions).
- Production frontend build: passed.
- Native Chromium two-peer media suite on the initial package: 2 tests passed, 1080p24/30 with zero dropped frames. Run with `cd frontend && npm run e2e:media`.
  It checks 1080p24/30, microphone/camera/screen soundtrack coexistence, ICE restart,
  live bitrate changes, 1080→720→1080 recovery, and share stop/start.

The browser media tests use a synthetic moving source and local ICE. They do not establish
WAN/TURN performance or perceptual quality on the users' actual movie and hardware.
The media suite was not rerun during the active live session after the recovery follow-up;
that follow-up passed the full unit/hook suite, production build, and targeted ESLint.

## Release isolation

Base: `e6f8d24bb733a51f9ebb456a5b022fd57f6a8405`.
Branch: `codex/streaming-quality`.

The repository's production workflow triggers on pushes to `main` or manual dispatch.
This feature-branch push does not match that trigger. No merge or deploy is included
in this packaging operation. Review and release separately after the active session.

## Follow-up from the live session

A user-authorized diagnostic read on 27 September 2026 confirmed that the encoder
sent 478x268 at roughly 24 fps for the visible three-minute history, although the
requested size increased from 1600x900 to 1920x1080. The peer independently reported
receiving 478x268. The film player itself was rendering 1920x1040.

The selected path was direct P2P/UDP, with about 75–78 ms RTT. The selected candidate
pair estimated 9.41 Mbps available outgoing bandwidth. The app requested a 3.10 Mbps
video ceiling and the encoder target was 2.83 Mbps. These are an estimate, a ceiling,
and an encoder target respectively; the report does not measure actual byte throughput.
Earlier logs repeatedly reduced the app ceiling to 250 kbps. No live settings or
playback were changed; the diagnostic panel was closed after reading.

Low local capture dimensions do not uniquely identify stale app constraints:
[libwebrtc adaptation](https://chromium.googlesource.com/external/webrtc.git/+/HEAD/video/g3doc/adaptation.md)
can propagate pixel restrictions upstream. The additional recovery therefore only
retries failed capture requests or demonstrably stale restrictive track constraints.
It is bounded, serialized with quality changes, and cancelled when sharing stops.
Correctly permissive constraints with low actual output do not trigger speculative
capture restarts. Small native sources and different aspect ratios remain valid.

This follow-up is not a claim that the revised build has fixed the users' live call.
The revised build has not been deployed to that call. Raw reports, session identifiers,
and track identifiers are intentionally excluded from this package.
