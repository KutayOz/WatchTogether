export interface BrowserInfo {
  name: 'chrome' | 'firefox' | 'safari' | 'opera' | 'edge' | 'ie' | 'unknown';
  version: number;
  supportLevel: 'full' | 'partial' | 'unsupported';
  warnings: string[];
  isMobile: boolean;
}

export interface CompatibilityWarnings {
  blocking: string | null;
  warnings: string[];
}

/**
 * Detect the current browser and its version
 */
export function detectBrowser(): BrowserInfo {
  const ua = navigator.userAgent;
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

  let name: BrowserInfo['name'] = 'unknown';
  let version = 0;
  let supportLevel: BrowserInfo['supportLevel'] = 'full';
  const warnings: string[] = [];

  // Opera detection (must be before Chrome since Opera includes "Chrome" in UA)
  if (ua.includes('OPR/') || ua.includes('Opera')) {
    name = 'opera';
    const match = ua.match(/OPR\/(\d+)/);
    version = match ? parseInt(match[1], 10) : 0;
    supportLevel = 'partial';
    warnings.push(
      "Opera's built-in VPN and ad blocker may interfere with video connections. " +
      "If you experience issues, please disable them or use Chrome/Firefox."
    );
  }
  // Edge detection (Chromium-based)
  else if (ua.includes('Edg/')) {
    name = 'edge';
    const match = ua.match(/Edg\/(\d+)/);
    version = match ? parseInt(match[1], 10) : 0;
    if (version < 80) {
      supportLevel = 'partial';
      warnings.push('Please update Microsoft Edge for the best experience.');
    }
  }
  // Chrome detection
  else if (ua.includes('Chrome/') && !ua.includes('Chromium')) {
    name = 'chrome';
    const match = ua.match(/Chrome\/(\d+)/);
    version = match ? parseInt(match[1], 10) : 0;
    if (version < 80) {
      supportLevel = 'partial';
      warnings.push('Please update Chrome for the best experience.');
    }
  }
  // Firefox detection
  else if (ua.includes('Firefox/')) {
    name = 'firefox';
    const match = ua.match(/Firefox\/(\d+)/);
    version = match ? parseInt(match[1], 10) : 0;
    if (version < 78) {
      supportLevel = 'partial';
      warnings.push('Please update Firefox for the best experience.');
    }
  }
  // Safari detection (must be after Chrome and Firefox)
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    name = 'safari';
    const match = ua.match(/Version\/(\d+)/);
    version = match ? parseInt(match[1], 10) : 0;
    if (version < 15) {
      supportLevel = 'partial';
      warnings.push(
        'Safari may have limited screen sharing capabilities. ' +
        'For the best experience, use Chrome or Firefox.'
      );
    }
  }
  // IE detection
  else if (ua.includes('MSIE') || ua.includes('Trident/')) {
    name = 'ie';
    supportLevel = 'unsupported';
    warnings.push('Internet Explorer does not support video calling features.');
  }
  // Old Edge (non-Chromium)
  else if (ua.includes('Edge/')) {
    name = 'edge';
    supportLevel = 'unsupported';
    warnings.push('This version of Edge does not support video calling. Please update to the latest version.');
  }

  return {
    name,
    version,
    supportLevel,
    warnings,
    isMobile,
  };
}

/**
 * Check if WebRTC APIs are available
 * Separates essential features (blocking) from optional features (warning only)
 */
export function checkWebRTCSupport(): {
  supported: boolean;
  missingEssential: string[];
  missingOptional: string[];
} {
  const missingEssential: string[] = [];
  const missingOptional: string[] = [];

  // Essential - needed for basic video calling (blocking if missing)
  if (!('RTCPeerConnection' in window)) {
    missingEssential.push('RTCPeerConnection');
  }

  if (!navigator?.mediaDevices?.getUserMedia) {
    missingEssential.push('getUserMedia (camera/microphone)');
  }

  // Optional - screen sharing (not required to use the app)
  if (!navigator?.mediaDevices?.getDisplayMedia) {
    missingOptional.push('Screen sharing');
  }

  return {
    supported: missingEssential.length === 0,
    missingEssential,
    missingOptional,
  };
}

/**
 * Get compatibility warnings to display to the user
 */
export function getCompatibilityWarnings(): CompatibilityWarnings {
  const browser = detectBrowser();
  const webrtc = checkWebRTCSupport();

  // Blocking warnings - only for unsupported browsers or missing ESSENTIAL features
  if (browser.supportLevel === 'unsupported') {
    return {
      blocking: browser.warnings[0] || 'Your browser is not supported. Please use Chrome, Firefox, or Edge.',
      warnings: [],
    };
  }

  if (!webrtc.supported) {
    return {
      blocking: `Your browser is missing essential features: ${webrtc.missingEssential.join(', ')}. Please use a modern browser like Chrome or Firefox.`,
      warnings: [],
    };
  }

  // Non-blocking warnings (including optional missing features)
  const warnings = [...browser.warnings];

  if (webrtc.missingOptional.length > 0) {
    warnings.push(
      `${webrtc.missingOptional.join(', ')} is not available on your device. You can still watch and chat, but won't be able to share your screen.`
    );
  }

  return {
    blocking: null,
    warnings,
  };
}

/**
 * Storage key for dismissed warnings
 */
const DISMISSED_WARNINGS_KEY = 'watchtogether_dismissed_warnings';

/**
 * Check if user has dismissed the warning for this browser
 */
export function hasUserDismissedWarning(browserName: string): boolean {
  try {
    const dismissed = localStorage.getItem(DISMISSED_WARNINGS_KEY);
    if (dismissed) {
      const list = JSON.parse(dismissed) as string[];
      return list.includes(browserName);
    }
  } catch {
    // Ignore localStorage errors
  }
  return false;
}

/**
 * Mark warning as dismissed for this browser
 */
export function dismissWarning(browserName: string): void {
  try {
    const dismissed = localStorage.getItem(DISMISSED_WARNINGS_KEY);
    const list = dismissed ? (JSON.parse(dismissed) as string[]) : [];
    if (!list.includes(browserName)) {
      list.push(browserName);
      localStorage.setItem(DISMISSED_WARNINGS_KEY, JSON.stringify(list));
    }
  } catch {
    // Ignore localStorage errors
  }
}
