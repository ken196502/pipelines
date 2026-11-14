export interface SelectorDefinition {
  css: string;
  description: string;
}

/**
 * The single registry of x.com selectors. A DOM change is fixed here, never by
 * adding a second, looser selector at a call site.
 */
export const SELECTORS = {
  tweet: {
    css: 'article[data-testid="tweet"]',
    description: 'One post in a timeline or search result',
  },
  tweetText: {
    css: '[data-testid="tweetText"]',
    description: 'Post body text',
  },
  tweetUser: {
    css: '[data-testid="User-Name"]',
    description: 'Author block with display name and handle',
  },
  tweetTime: {
    css: 'time[datetime]',
    description: 'Post timestamp with an ISO datetime attribute',
  },
  tweetStatusLink: {
    css: 'a[href*="/status/"]',
    description: 'Permalink of a post',
  },
  socialContext: {
    css: '[data-testid="socialContext"]',
    description: 'Repost / pinned context above a post',
  },
  promotedTracking: {
    css: '[data-testid="placementTracking"]',
    description: 'Promoted-post tracking wrapper',
  },
  loggedInMarker: {
    css: '[data-testid="SideNav_AccountSwitcher_Button"]',
    description: 'Account switcher, only present when logged in',
  },
  articlesCreate: {
    css: '[aria-label="create"]',
    description: 'Create button on /compose/articles',
  },
  articleTitle: {
    css: 'textarea[name="Article Title"]',
    description: 'Article title field',
  },
  articleComposer: {
    css: 'div[data-testid="composer"][contenteditable="true"]',
    description: 'Article body editor',
  },
  coverFileInput: {
    css: 'input[type="file"]',
    description: 'Cover image file input (video accept values are excluded at the call site)',
  },
  coverImage: {
    css: 'img[src]',
    description: 'Uploaded cover preview',
  },
} as const satisfies Record<string, SelectorDefinition>;

export type SelectorName = keyof typeof SELECTORS;

export function selectorCss(name: SelectorName): string {
  return SELECTORS[name].css;
}
