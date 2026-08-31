import { randomBytes } from 'crypto';

const PUBLIC_ID_BYTES = 8;

/**
 * Short, URL-safe, unguessable identifier for a video's public URL.
 * 8 random bytes encode to 11 base64url characters — the same length and
 * entropy as nanoid(11), without the ESM-only dependency.
 */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
