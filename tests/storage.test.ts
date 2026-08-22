/**
 * Unit tests for storage validation and defaults (tasks.md 2.3).
 *
 * `chrome.storage.local` is faked with a plain object behind the `platform`
 * module, so these tests cover the real code path the extension uses (including
 * the version stamp on every write) without a browser. Values go through
 * `structuredClone` on the way in and out, exactly as the real API does — that
 * is what catches a getter handing callers a reference to a stored object.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { DEFAULT_SETTINGS, STORAGE_VERSION } from '../src/types';
import type { Settings } from '../src/types';

const { store, mockApi } = (() => {
  const store: Record<string, unknown> = {};

  const local = {
    get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      const names =
        keys === undefined || keys === null
          ? Object.keys(store)
          : typeof keys === 'string'
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : Object.keys(keys);
      const out: Record<string, unknown> = {};
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(store, name)) {
          out[name] = structuredClone(store[name]);
        }
      }
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        store[key] = structuredClone(value);
      }
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete store[key];
      return Promise.resolve();
    },
    clear(): Promise<void> {
      for (const key of Object.keys(store)) delete store[key];
      return Promise.resolve();
    },
  };

  return { store, mockApi: { storage: { local } } };
})();

mock.module('../src/platform', () => ({
  api: mockApi as unknown as typeof chrome,
  isFirefox: () => false,
  createAlarm: () => Promise.resolve(),
  forgetClosed: () => Promise.resolve(),
}));

const {
  InvalidCutoffsError,
  STORAGE_KEYS,
  bumpStats,
  getLastAutoCutoffId,
  getLastSweep,
  getSettings,
  getStats,
  isAccepted,
  markAccepted,
  setLastAutoCutoffId,
  setLastSweep,
  setSettings,
  validateCutoffs,
} = await import('../src/storage');

/** A valid settings object to mutate per test. */
function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, cutoffs: [...DEFAULT_SETTINGS.cutoffs], ...overrides };
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('validateCutoffs', () => {
  it('returns a new sorted array without mutating the input', () => {
    const input = ['18:00', '09:05', '13:00'];
    const result = validateCutoffs(input);
    expect(result).toEqual(['09:05', '13:00', '18:00']);
    expect(input).toEqual(['18:00', '09:05', '13:00']);
    expect(result).not.toBe(input);
  });

  it('accepts the boundary sizes 1 and 4', () => {
    expect(validateCutoffs(['18:00'])).toEqual(['18:00']);
    expect(validateCutoffs(['23:59', '00:00', '13:00', '09:00'])).toEqual([
      '00:00',
      '09:00',
      '13:00',
      '23:59',
    ]);
  });

  it('rejects an empty schedule', () => {
    expect(() => validateCutoffs([])).toThrow(InvalidCutoffsError);
    try {
      validateCutoffs([]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InstanceType<typeof InvalidCutoffsError>).code).toBe('too-few');
    }
  });

  it('rejects a fifth cutoff', () => {
    try {
      validateCutoffs(['09:00', '12:00', '15:00', '18:00', '21:00']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InstanceType<typeof InvalidCutoffsError>).code).toBe('too-many');
    }
  });

  it('rejects duplicates', () => {
    try {
      validateCutoffs(['18:00', '13:00', '18:00']);
      expect.unreachable('should have thrown');
    } catch (error) {
      const invalid = error as InstanceType<typeof InvalidCutoffsError>;
      expect(invalid.code).toBe('duplicate');
      expect(invalid.value).toBe('18:00');
    }
  });

  it('rejects "9:00" but accepts "09:00" — padding keeps ids lexically ordered', () => {
    try {
      validateCutoffs(['9:00']);
      expect.unreachable('should have thrown');
    } catch (error) {
      const invalid = error as InstanceType<typeof InvalidCutoffsError>;
      expect(invalid.code).toBe('format');
      expect(invalid.value).toBe('9:00');
    }
    expect(validateCutoffs(['09:00'])).toEqual(['09:00']);
  });

  it('rejects "24:00" and other out-of-range or malformed entries', () => {
    for (const bad of ['24:00', '23:60', '18:0', '1800', '', 'noon', '18:00 ']) {
      expect(() => validateCutoffs([bad]), bad).toThrow(InvalidCutoffsError);
    }
    expect(() => validateCutoffs([42 as unknown as string])).toThrow(InvalidCutoffsError);
  });
});

describe('getSettings', () => {
  it('returns the documented defaults when nothing is stored', async () => {
    await expect(getSettings()).resolves.toEqual({
      cutoffs: ['18:00'],
      noticeMinutes: 10,
      notify: true,
      autoBookmark: false,
      keepPinned: false,
      locale: 'auto',
    });
  });

  it('merges a partial stored object over the defaults', async () => {
    store.settings = { noticeMinutes: 30 };
    await expect(getSettings()).resolves.toEqual({
      cutoffs: ['18:00'],
      noticeMinutes: 30,
      notify: true,
      autoBookmark: false,
      keepPinned: false,
      locale: 'auto',
    });
  });

  it('falls back per field when a stored value is corrupt', async () => {
    store.settings = {
      cutoffs: ['9:00', '9:00'],
      noticeMinutes: 999,
      notify: 'yes',
      keepPinned: true,
    };
    await expect(getSettings()).resolves.toEqual({
      cutoffs: ['18:00'],
      noticeMinutes: 10,
      notify: true,
      autoBookmark: false,
      keepPinned: true, // the one valid field survives
      locale: 'auto',
    });
  });

  it('survives a wholly wrong stored type', async () => {
    for (const junk of ['nonsense', 42, null, []]) {
      store.settings = junk;
      await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    }
  });

  it('sorts a stored-but-unsorted schedule', async () => {
    store.settings = { cutoffs: ['18:00', '09:00'] };
    await expect(getSettings()).resolves.toMatchObject({ cutoffs: ['09:00', '18:00'] });
  });

  it('never hands back the shared DEFAULT_SETTINGS arrays', async () => {
    const first = await getSettings();
    first.cutoffs.push('23:00');
    const second = await getSettings();
    expect(second.cutoffs).toEqual(['18:00']);
    expect(DEFAULT_SETTINGS.cutoffs).toEqual(['18:00']);
  });
});

describe('setSettings', () => {
  it('persists a normalised copy and stamps the schema version', async () => {
    await setSettings(settings({ cutoffs: ['18:00', '13:00'], noticeMinutes: 0, notify: false }));
    expect(store.settings).toEqual({
      cutoffs: ['13:00', '18:00'],
      noticeMinutes: 0,
      notify: false,
      autoBookmark: false,
      keepPinned: false,
      locale: 'auto',
    });
    expect(store.version).toBe(STORAGE_VERSION);
    expect(STORAGE_VERSION).toBe(1);
    await expect(getSettings()).resolves.toMatchObject({ cutoffs: ['13:00', '18:00'] });
  });

  it('writes nothing when the cutoffs are invalid', async () => {
    await expect(setSettings(settings({ cutoffs: [] }))).rejects.toBeInstanceOf(
      InvalidCutoffsError,
    );
    await expect(setSettings(settings({ cutoffs: ['9:00'] }))).rejects.toBeInstanceOf(
      InvalidCutoffsError,
    );
    await expect(setSettings(settings({ cutoffs: ['24:00'] }))).rejects.toBeInstanceOf(
      InvalidCutoffsError,
    );
    expect(store.settings).toBeUndefined();
  });

  it('accepts the whole 0–60 notice range and rejects outside it', async () => {
    for (const minutes of [0, 1, 10, 60]) {
      await setSettings(settings({ noticeMinutes: minutes }));
      await expect(getSettings()).resolves.toMatchObject({ noticeMinutes: minutes });
    }
    for (const minutes of [-1, 61, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(setSettings(settings({ noticeMinutes: minutes }))).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    // The last accepted value is still what is stored.
    await expect(getSettings()).resolves.toMatchObject({ noticeMinutes: 60 });
  });
});

describe('lastAutoCutoffId', () => {
  it('defaults to the empty string, which sorts before every real id', async () => {
    await expect(getLastAutoCutoffId()).resolves.toBe('');
    expect('' < '2026-08-19T18:00').toBe(true);
  });

  it('round-trips', async () => {
    await setLastAutoCutoffId('2026-08-19T18:00');
    await expect(getLastAutoCutoffId()).resolves.toBe('2026-08-19T18:00');
    expect(store.version).toBe(STORAGE_VERSION);
  });

  it('ignores a corrupt stored value rather than throwing', async () => {
    store.lastAutoCutoffId = { nope: true };
    await expect(getLastAutoCutoffId()).resolves.toBe('');
  });
});

describe('lastSweep and stats', () => {
  it('reports no last sweep before the first one', async () => {
    await expect(getLastSweep()).resolves.toBeUndefined();
  });

  it('round-trips a sweep record', async () => {
    await setLastSweep({ reason: 'manual', at: 1_755_000_000_000, closed: 37 });
    await expect(getLastSweep()).resolves.toEqual({
      reason: 'manual',
      at: 1_755_000_000_000,
      closed: 37,
      bookmarked: false,
    });
  });

  it('round-trips the bookmarked-first flag', async () => {
    await setLastSweep({ reason: 'auto', at: 1_755_000_000_000, closed: 12, bookmarked: true });
    await expect(getLastSweep()).resolves.toEqual({
      reason: 'auto',
      at: 1_755_000_000_000,
      closed: 12,
      bookmarked: true,
    });
  });

  it('treats a malformed record as absent', async () => {
    for (const junk of [{ reason: 'settle', at: 1, closed: 1 }, { reason: 'auto' }, 'nope', 7]) {
      store.lastSweep = junk;
      await expect(getLastSweep()).resolves.toBeUndefined();
    }
  });

  it('accumulates lifetime stats, including zero-tab sweeps', async () => {
    await expect(getStats()).resolves.toEqual({ lifetimeClosed: 0 });
    await expect(bumpStats(37)).resolves.toEqual({ lifetimeClosed: 37 });
    await expect(bumpStats(0)).resolves.toEqual({ lifetimeClosed: 37 });
    await expect(bumpStats(5)).resolves.toEqual({ lifetimeClosed: 42 });
    await expect(getStats()).resolves.toEqual({ lifetimeClosed: 42 });
  });

  it('recovers from corrupt stats instead of producing NaN', async () => {
    store.stats = { lifetimeClosed: 'lots' };
    await expect(getStats()).resolves.toEqual({ lifetimeClosed: 0 });
    await expect(bumpStats(3)).resolves.toEqual({ lifetimeClosed: 3 });
    await expect(bumpStats(-1)).resolves.toEqual({ lifetimeClosed: 3 });
  });
});

describe('acceptance', () => {
  it('is false until marked, then true and idempotent', async () => {
    await expect(isAccepted()).resolves.toBe(false);
    await markAccepted();
    await expect(isAccepted()).resolves.toBe(true);
    await markAccepted();
    await expect(isAccepted()).resolves.toBe(true);
  });
});

describe('the no-archive guarantee', () => {
  it('writes only the keys on the exhaustive list', async () => {
    // Exercise every writer in the module; nothing outside STORAGE_KEYS may
    // appear in storage. This is the check that keeps the "nothing is saved"
    // contract and the Firefox data_collection_permissions honest (design.md D6).
    await setSettings(settings({ cutoffs: ['13:00', '18:00'], keepPinned: true }));
    await setLastAutoCutoffId('2026-08-19T18:00');
    await setLastSweep({ reason: 'auto', at: Date.now(), closed: 12 });
    await bumpStats(12);
    await markAccepted();

    expect(new Set(Object.keys(store))).toEqual(new Set(STORAGE_KEYS));
    // ...and nothing per-tab hides inside the values.
    expect(JSON.stringify(store)).not.toMatch(/https?:/);
  });
});
