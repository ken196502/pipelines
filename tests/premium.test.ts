import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../src/lib/errors.js';
import { detectPremiumMarker } from '../src/module/premium/detect.js';

describe('detectPremiumMarker', () => {
  const markers = ['[Premium]', 'Premium article:'];

  it('detects a case-insensitive prefix', () => {
    const result = detectPremiumMarker('[premium] A long read', markers);
    assert.equal(result.detected, true);
    assert.equal(result.marker, '[Premium]');
  });

  it('trims leading whitespace and zero-width characters', () => {
    const result = detectPremiumMarker('\u200b\u200c\u200d\ufeff  \n[Premium] Body', markers);
    assert.equal(result.detected, true);
    assert.equal(result.leadingText, '[Premium] Body');
  });

  it('does not detect a marker in the middle of the text', () => {
    const result = detectPremiumMarker('Intro. [Premium] later in the text', markers);
    assert.equal(result.detected, false);
    assert.equal(result.marker, undefined);
  });

  it('returns the leading text when nothing matches', () => {
    const result = detectPremiumMarker('Just a normal draft', markers);
    assert.equal(result.detected, false);
    assert.equal(result.leadingText, 'Just a normal draft');
  });

  it('rejects an empty marker list', () => {
    assert.throws(() => detectPremiumMarker('text', []), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'PREMIUM_MARKERS_EMPTY');
      return true;
    });
  });
});
