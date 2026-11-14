import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSearchUrl, parseTweetRecords, type RawTweetRecord } from '../src/module/x/search.js';

function record(overrides: Partial<RawTweetRecord> = {}): RawTweetRecord {
  return {
    href: '/alice/status/111',
    authorText: 'Alice\n@alice',
    authorHref: '/alice',
    time: '2026-11-01T10:00:00.000Z',
    text: 'Agent orchestration is changing how teams build systems.',
    socialContext: null,
    placementTracking: null,
    adLabel: null,
    ...overrides,
  };
}

describe('buildSearchUrl', () => {
  it('encodes the query and sets src and feed', () => {
    const url = buildSearchUrl('Agent system & tools', { feed: 'top', baseUrl: 'https://x.com' });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/search');
    assert.equal(parsed.searchParams.get('q'), 'Agent system & tools');
    assert.equal(parsed.searchParams.get('src'), 'typed_query');
    assert.equal(parsed.searchParams.get('f'), 'top');
    assert.ok(url.includes('q=Agent+system+%26+tools'));
  });

  it('uses the live feed and appends lang only when asked', () => {
    const withoutLang = new URL(buildSearchUrl('agents', { feed: 'live', baseUrl: 'https://x.com' }));
    assert.equal(withoutLang.searchParams.get('f'), 'live');
    assert.equal(withoutLang.searchParams.get('q'), 'agents');

    const withLang = new URL(
      buildSearchUrl('agents', { feed: 'top', languageOperator: 'en', baseUrl: 'https://x.com' }),
    );
    assert.equal(withLang.searchParams.get('q'), 'agents lang:en');
  });

  it('honours an injected base url', () => {
    assert.ok(buildSearchUrl('agents', { feed: 'top', baseUrl: 'http://127.0.0.1:1234' }).startsWith('http://127.0.0.1:1234/search?'));
  });
});

describe('parseTweetRecords', () => {
  it('parses a normal post', () => {
    const result = parseTweetRecords([record()]);
    assert.deepEqual(result.tweets, [
      {
        id: '111',
        url: 'https://x.com/alice/status/111',
        author: 'alice',
        createdAt: '2026-11-01T10:00:00.000Z',
        text: 'Agent orchestration is changing how teams build systems.',
      },
    ]);
    assert.deepEqual(result.dropped, { promoted: 0, retweet: 0, malformed: 0 });
  });

  it('drops reposts', () => {
    const result = parseTweetRecords([record({ socialContext: 'Bob reposted' })]);
    assert.equal(result.tweets.length, 0);
    assert.equal(result.dropped.retweet, 1);
  });

  it('drops promoted posts by tracking node', () => {
    const result = parseTweetRecords([record({ placementTracking: 'Promoted by Acme' })]);
    assert.equal(result.tweets.length, 0);
    assert.equal(result.dropped.promoted, 1);
  });

  it('drops promoted posts by an exact Ad label', () => {
    const result = parseTweetRecords([record({ adLabel: 'Ad' })]);
    assert.equal(result.dropped.promoted, 1);
  });

  it('does not treat "Add" or "Adobe" as an ad label', () => {
    const result = parseTweetRecords([
      record({ text: 'Add Adobe tools to your agent stack', adLabel: null }),
    ]);
    assert.equal(result.tweets.length, 1);
    assert.equal(result.dropped.promoted, 0);
  });

  it('counts malformed records instead of inventing data', () => {
    const result = parseTweetRecords([
      record({ href: null }),
      record({ authorHref: null, authorText: 'no handle here' }),
      record({ time: null }),
      record({ time: 'not-a-date' }),
      record({ text: '   ' }),
    ]);
    assert.equal(result.tweets.length, 0);
    assert.equal(result.dropped.malformed, 5);
  });

  it('keeps the pinned context but parses the post', () => {
    const result = parseTweetRecords([record({ socialContext: 'Pinned' })]);
    assert.equal(result.tweets.length, 1);
    assert.equal(result.dropped.retweet, 0);
  });
});
