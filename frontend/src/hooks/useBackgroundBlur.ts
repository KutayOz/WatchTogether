import { logger } from '../services/logger';
import { useEffect, useRef, useState } from 'react';

/**
 * Background blur using MediaPipe's selfie segmenter.
 *
 * Pipeline per frame (~30 fps target):
 *   1. Sample the live <video> element (created from the camera track).
 *   2. Run the segmenter → category mask (1 = person, 0 = background).
 *   3. Draw the original frame to a working canvas.
 *   4. Composite a blurred copy of the same frame over the background
 *      pixels, leaving the person intact.
 *   5. canvas.captureStream() exposes the result as a new MediaStreamTrack
 *      the caller can hand to RTCRtpSender.replaceTrack().
 *
 * Why canvas + captureStream and not the MediaStreamTrackProcessor / -Generator
 * API: those are still Origin-Trial in Safari. captureStream is universally
 * supported and the performance difference is negligible at 480p/30fps.
 *
 * Lazy import: the @mediapipe/tasks-vision module + WASM model is ~2MB,
 * dynamic-imported inside the effect so users who never enable blur don't
 * pay the cost.
 */

interface UseBackgroundBlurOptions {
  /** The raw camera track. Pass null to disable. */
  sourceTrack: MediaStreamTrack | null;
  /** When false, hook returns sourceTrack unchanged (zero overhead). */
  enabled: boolean;
}

interface UseBackgroundBlurReturn {
  /** The track to feed into the peer connection. Same as sourceTrack when
   *  disabled, a synthetic canvas track when enabled. */
  outputTrack: MediaStreamTrack | null;
  /** True while the segmenter model is downloading on first use. */
  isLoading: boolean;
  /** Init-failure message — caller falls back to the raw track. */
  error: string | null;
}

// Module-level cache for the segmenter — created once per page load,
// re-used across mount/unmount cycles. Re-instantiating per-mount is
// expensive (downloads model again).
let segmenterPromise: Promise<unknown> | null = null;

export function useBackgroundBlur({ sourceTrack, enabled }: UseBackgroundBlurOptions): UseBackgroundBlurReturn {
  const [outputTrack, setOutputTrack] = useState<MediaStreamTrack | null>(sourceTrack);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;

    if (!sourceTrack) {
      setOutputTrack(null);
      return;
    }
    if (!enabled) {
      // Hand the raw track straight through. No canvas, no compositor.
      setOutputTrack(sourceTrack);
      return;
    }

    setIsLoading(true);
    setError(null);

    let stop: (() => void) | null = null;

    (async () => {
      try {
        const tasksVision = await import('@mediapipe/tasks-vision');
        const { ImageSegmenter, FilesetResolver } = tasksVision;

        if (!segmenterPromise) {
          segmenterPromise = (async () => {
            // CDN-hosted WASM bundle. The runner ships separately from the
            // model — CDN-served WASM keeps our app bundle tiny.
            const fileset = await FilesetResolver.forVisionTasks(
              'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm',
            );
            return ImageSegmenter.createFromOptions(fileset, {
              baseOptions: {
                modelAssetPath:
                  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
                delegate: 'GPU',
              },
              runningMode: 'VIDEO',
              outputCategoryMask: true,
              outputConfidenceMasks: false,
            });
          })();
        }
        // ImageSegmenter has a private constructor in the type definitions
        // so we can't use InstanceType<>. The runtime value is a concrete
        // instance — type via ReturnType of the static factory instead.
        const segmenter = (await segmenterPromise) as Awaited<ReturnType<typeof ImageSegmenter.createFromOptions>>;

        if (cancelRef.current) return;

        // Set up the rendering pipeline. We use one offscreen for the
        // person mask + blurred backdrop composition, and one onscreen
        // (well, captureStream-source) canvas as the final output.
        const video = document.createElement('video');
        video.srcObject = new MediaStream([sourceTrack]);
        video.muted = true;
        video.playsInline = true;
        await video.play();

        const width = sourceTrack.getSettings().width ?? 640;
        const height = sourceTrack.getSettings().height ?? 480;

        const output = document.createElement('canvas');
        output.width = width;
        output.height = height;
        const ctx = output.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('canvas 2d not available');

        const blurredBg = document.createElement('canvas');
        blurredBg.width = width;
        blurredBg.height = height;
        const blurredCtx = blurredBg.getContext('2d');
        if (!blurredCtx) throw new Error('blurred canvas 2d not available');

        let rafHandle = 0;
        const targetFps = 30;
        const frameInterval = 1000 / targetFps;
        let lastFrameAt = 0;

        const renderFrame = (timestamp: number) => {
          if (cancelRef.current) return;
          rafHandle = requestAnimationFrame(renderFrame);
          if (timestamp - lastFrameAt < frameInterval) return;
          lastFrameAt = timestamp;
          if (video.readyState < 2) return;

          try {
            // Blurred backdrop: just draw the source through a heavy
            // CSS filter. 18px is a good middle-ground — readable enough
            // that you sense the room, unreadable enough for privacy.
            blurredCtx.filter = 'blur(18px)';
            blurredCtx.drawImage(video, 0, 0, width, height);
            blurredCtx.filter = 'none';

            // Foreground: original frame, no blur.
            ctx.drawImage(video, 0, 0, width, height);

            // Mask: ImageSegmenter returns a category mask where person
            // pixels are 0 (foreground "selfie" class) and background
            // pixels are non-zero. We turn that into a per-pixel keep-
            // background decision.
            const result = segmenter.segmentForVideo(video, performance.now());
            const mask = result.categoryMask;
            if (!mask) {
              result.close?.();
              return;
            }
            const maskData = mask.getAsUint8Array();
            const frameData = ctx.getImageData(0, 0, width, height);
            const bgData = blurredCtx.getImageData(0, 0, width, height);

            // The mask resolution can differ from the canvas; the model
            // outputs 256x256 by default. Sample with nearest-neighbour
            // mapping per-pixel — cheap and good-enough at 30 fps.
            const maskW = mask.width;
            const maskH = mask.height;
            const dstPx = frameData.data;
            const srcBg = bgData.data;
            for (let y = 0; y < height; y++) {
              const mY = Math.floor((y / height) * maskH);
              for (let x = 0; x < width; x++) {
                const mX = Math.floor((x / width) * maskW);
                const mi = mY * maskW + mX;
                // category = 0 means "person" — keep the original pixel.
                // Anything else means background — copy the blurred one.
                if (maskData[mi] !== 0) {
                  const di = (y * width + x) * 4;
                  dstPx[di] = srcBg[di];
                  dstPx[di + 1] = srcBg[di + 1];
                  dstPx[di + 2] = srcBg[di + 2];
                  dstPx[di + 3] = 255;
                }
              }
            }
            ctx.putImageData(frameData, 0, 0);

            mask.close?.();
            result.close?.();
          } catch (err) {
            logger.warn('[BgBlur] frame error:', err);
          }
        };

        rafHandle = requestAnimationFrame(renderFrame);
        const captureStream = output.captureStream(targetFps);
        const newVideoTrack = captureStream.getVideoTracks()[0];

        // Propagate stop signals: when the *source* track ends (user toggled
        // camera off, hot-swapped device), our synthetic track ends too.
        const onSourceEnd = () => newVideoTrack.stop();
        sourceTrack.addEventListener('ended', onSourceEnd);

        stop = () => {
          cancelRef.current = true;
          cancelAnimationFrame(rafHandle);
          sourceTrack.removeEventListener('ended', onSourceEnd);
          try { newVideoTrack.stop(); } catch { /* ignore */ }
          try { video.srcObject = null; } catch { /* ignore */ }
        };

        if (!cancelRef.current) {
          setOutputTrack(newVideoTrack);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelRef.current) {
          logger.warn('[BgBlur] init failed:', err);
          setError(err instanceof Error ? err.message : 'background blur unavailable');
          setIsLoading(false);
          // Graceful fallback — return the raw track so the user still has
          // a video, just without the blur.
          setOutputTrack(sourceTrack);
        }
      }
    })();

    return () => {
      cancelRef.current = true;
      stop?.();
    };
  }, [sourceTrack, enabled]);

  return { outputTrack, isLoading, error };
}
