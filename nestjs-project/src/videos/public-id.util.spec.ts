import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('returns an 11-character identifier', () => {
    expect(generatePublicId()).toHaveLength(11);
  });

  it('uses only URL-safe characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('does not collide across many generations', () => {
    const generated = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      generated.add(generatePublicId());
    }
    expect(generated.size).toBe(10000);
  });

  it('fits within the public_id column width', () => {
    expect(generatePublicId().length).toBeLessThanOrEqual(16);
  });
});
