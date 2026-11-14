import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { XError } from '../src/lib/errors.js';
import { safeClick, type ClickableElement } from '../src/module/x/safe-click.js';

function element(labels: { text?: string; ariaLabel?: string | null; testId?: string | null }) {
  const calls = { clicked: 0 };
  const target: ClickableElement = {
    async getText() {
      return labels.text ?? '';
    },
    async getAttribute(name: string) {
      if (name === 'aria-label') return labels.ariaLabel ?? null;
      if (name === 'data-testid') return labels.testId ?? null;
      return null;
    },
    async click() {
      calls.clicked += 1;
    },
  };
  return { target, calls };
}

describe('safeClick', () => {
  it('refuses a button labelled Publish and does not click it', async () => {
    const { target, calls } = element({ text: 'Publish' });
    await assert.rejects(safeClick(target, 'apply'), (err: unknown) => {
      assert.ok(err instanceof XError);
      assert.equal(err.code, 'X_PUBLISH_FORBIDDEN');
      assert.equal(err.context.purpose, 'apply');
      return true;
    });
    assert.equal(calls.clicked, 0);
  });

  it('refuses a button labelled Post', async () => {
    const { target, calls } = element({ text: 'Post' });
    await assert.rejects(safeClick(target, 'apply'), (err: unknown) => {
      assert.ok(err instanceof XError);
      assert.equal(err.code, 'X_PUBLISH_FORBIDDEN');
      return true;
    });
    assert.equal(calls.clicked, 0);
  });

  it('refuses a tweetButton test id even with neutral text', async () => {
    const { target, calls } = element({ text: 'Go', testId: 'tweetButton' });
    await assert.rejects(safeClick(target, 'apply'), (err: unknown) => {
      assert.ok(err instanceof XError);
      assert.equal(err.code, 'X_PUBLISH_FORBIDDEN');
      return true;
    });
    assert.equal(calls.clicked, 0);
  });

  it('refuses an aria-label that mentions sharing', async () => {
    const { target, calls } = element({ text: '', ariaLabel: 'Share post' });
    await assert.rejects(safeClick(target, 'apply'), (err: unknown) => {
      assert.ok(err instanceof XError);
      assert.equal(err.code, 'X_PUBLISH_FORBIDDEN');
      return true;
    });
    assert.equal(calls.clicked, 0);
  });

  it('allows Apply and create', async () => {
    for (const labels of [{ text: 'Apply' }, { text: 'Create', ariaLabel: 'create' }]) {
      const { target, calls } = element(labels);
      await safeClick(target, 'apply');
      assert.equal(calls.clicked, 1);
    }
  });
});
