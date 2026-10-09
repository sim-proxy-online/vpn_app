import { describe, expect, it } from 'vitest';
import { MOOD_COLOR, moodFor } from './utils/mood';
import type { ConnectionState } from './types';

describe('moodFor', () => {
  it('protected is happy, whatever else is going on', () => {
    expect(moodFor('connected', false)).toBe('happy');
    expect(moodFor('connected', true)).toBe('happy');
  });

  it('every in-between state is thinking', () => {
    for (const s of ['connecting', 'verifying', 'reconnecting', 'disconnecting'] as ConnectionState[]) {
      expect(moodFor(s, false)).toBe('thinking');
      expect(moodFor(s, true)).toBe('thinking');
    }
  });

  it('not protected is cold; after a failed attempt it is confused', () => {
    expect(moodFor('disconnected', false)).toBe('cold');
    expect(moodFor('disconnected', true)).toBe('confused');
  });

  it('each mood has its own colour', () => {
    expect(new Set(Object.values(MOOD_COLOR)).size).toBe(4);
  });
});
