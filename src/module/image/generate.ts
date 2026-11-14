import { extname } from 'node:path';
import { writeFileAtomic } from '../../lib/fs/atomic.js';
import type { ImageClient } from '../../lib/image/openai-images.js';
import { validateImageBytes, type ImageInfo } from '../../lib/image/validate.js';
import type { ChatContext } from '../../lib/llm/types.js';

export interface GeneratedImage extends ImageInfo {
  path: string;
}

const EXTENSIONS: Record<ImageInfo['mime'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Generates one image, validates the bytes and writes them atomically.
 * Nothing is written when the bytes are invalid. A path without an extension
 * gets one from the detected mime type.
 */
export async function generateImage(
  imageClient: ImageClient,
  prompt: string,
  outPath: string,
  context: ChatContext,
): Promise<GeneratedImage> {
  const response = await imageClient.generate({ prompt, context });
  const info = validateImageBytes(response.bytes);
  const path = extname(outPath) === '' ? `${outPath}.${EXTENSIONS[info.mime]}` : outPath;
  await writeFileAtomic(path, response.bytes);
  return { path, ...info };
}
