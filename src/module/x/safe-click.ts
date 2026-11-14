import { XError } from '../../lib/errors.js';

export interface ClickableElement {
  getText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  click(): Promise<void>;
}

const PUBLISH_LIKE = /\b(publish|post|tweet|share|schedule)\b/i;

/** Splits camelCase so a data-testid like `tweetButton` is checked as words. */
function words(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * The only click helper in module/x. It refuses anything that looks like a
 * publish control, so the draft can never be published by accident.
 */
export async function safeClick(element: ClickableElement, purpose: string): Promise<void> {
  let text: string;
  let ariaLabel: string | null;
  let testId: string | null;
  try {
    [text, ariaLabel, testId] = await Promise.all([
      element.getText(),
      element.getAttribute('aria-label'),
      element.getAttribute('data-testid'),
    ]);
  } catch (err) {
    throw new XError(
      'X_SELECTOR_MISSING',
      `Cannot read the element for "${purpose}"; it may have been detached.`,
      { purpose },
      { cause: err },
    );
  }

  const labels = { text: text.trim(), ariaLabel: ariaLabel ?? '', testId: testId ?? '' };
  for (const [field, value] of Object.entries(labels)) {
    if (PUBLISH_LIKE.test(words(value))) {
      throw new XError(
        'X_PUBLISH_FORBIDDEN',
        `Refusing to click "${purpose}": its ${field} looks like a publish control (${JSON.stringify(value)}). This pipeline is draft-only.`,
        { purpose, labels },
      );
    }
  }

  await element.click();
}
