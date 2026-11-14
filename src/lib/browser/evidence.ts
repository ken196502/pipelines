import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonlLogger } from '../log/jsonl-logger.js';
import type { BrowserSession } from './firefox.js';

export interface EvidenceReport {
  label: string;
  screenshot?: string;
  page?: string;
  errors: string[];
}

const MAX_TEXT = 20_000;

function safeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'evidence';
}

/**
 * Captures a screenshot plus URL/title/body text for a failing step. Evidence
 * problems are logged as warnings; they never replace the original error.
 */
export async function captureEvidence(
  session: BrowserSession,
  dir: string,
  label: string,
  logger: JsonlLogger,
): Promise<EvidenceReport> {
  const name = safeLabel(label);
  const report: EvidenceReport = { label: name, errors: [] };

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    report.errors.push(`mkdir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn('evidence:error', { data: { label: name, error: report.errors[0] } });
    return report;
  }

  const screenshotPath = join(dir, `${name}.png`);
  try {
    await session.browser.saveScreenshot(screenshotPath);
    report.screenshot = screenshotPath;
  } catch (err) {
    report.errors.push(`screenshot: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn('evidence:error', { data: { label: name, error: report.errors.at(-1) } });
  }

  const pagePath = join(dir, `${name}.json`);
  try {
    const url = await session.browser.getUrl();
    const title = await session.browser.getTitle();
    const text = await session.browser.execute(() => (document.body ? document.body.innerText : ''));
    const page = { url, title, text: String(text).slice(0, MAX_TEXT) };
    await writeFile(pagePath, `${JSON.stringify(page, null, 2)}\n`, 'utf8');
    report.page = pagePath;
  } catch (err) {
    report.errors.push(`page: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn('evidence:error', { data: { label: name, error: report.errors.at(-1) } });
  }

  return report;
}
