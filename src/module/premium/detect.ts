import { ConfigError } from '../../lib/errors.js';

export interface PremiumResult {
  detected: boolean;
  marker?: string;
  leadingText: string;
}

const LEADING_NOISE = /^[\s\u200b\u200c\u200d\ufeff]+/;
const MAX_LEADING_TEXT = 500;

/**
 * Detects a configured Premium marker as a case-insensitive prefix of the
 * text. Leading whitespace and zero-width characters are ignored. There is no
 * fuzzy matching: a marker in the middle of the text is not detected.
 */
export function detectPremiumMarker(text: string, markers: readonly string[]): PremiumResult {
  if (markers.length === 0) {
    throw new ConfigError(
      'PREMIUM_MARKERS_EMPTY',
      'premium.markers is empty. Configure at least one literal marker prefix.',
      { markers },
    );
  }
  const trimmed = text.replace(LEADING_NOISE, '');
  const lowered = trimmed.toLowerCase();
  for (const marker of markers) {
    if (marker === '') {
      throw new ConfigError('PREMIUM_MARKERS_EMPTY', 'premium.markers contains an empty marker.', { markers });
    }
    if (lowered.startsWith(marker.toLowerCase())) {
      return { detected: true, marker, leadingText: trimmed.slice(0, MAX_LEADING_TEXT) };
    }
  }
  return { detected: false, leadingText: trimmed.slice(0, MAX_LEADING_TEXT) };
}
