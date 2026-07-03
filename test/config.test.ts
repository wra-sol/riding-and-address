import { describe, it, expect } from 'vitest';
import {
  getTimeoutConfig,
  getRetryConfig,
  TIMEOUT_CONFIG,
  RETRY_CONFIG,
  TIME_CONSTANTS,
  TIME_CONSTANTS_SECONDS,
  QUALITY_THRESHOLDS,
} from '../src/config';
import type { Env } from '../src/types';

describe('getTimeoutConfig', () => {
  it('returns default values when env is empty', () => {
    const env = {} as Env;
    const config = getTimeoutConfig(env);
    expect(config.geocoding).toBe(TIMEOUT_CONFIG.geocoding);
    expect(config.lookup).toBe(TIMEOUT_CONFIG.lookup);
    expect(config.batch).toBe(TIMEOUT_CONFIG.batch);
    expect(config.total).toBe(TIMEOUT_CONFIG.total);
    expect(config.webhook).toBe(TIMEOUT_CONFIG.webhook);
    expect(config.stages).toEqual({ oda: 3000, geogratis: 5000, fallback: 5000 });
  });

  it('reads numeric values from env', () => {
    const env = {
      GEOCODING_TIMEOUT: 15000,
      LOOKUP_TIMEOUT: 8000,
      TOTAL_TIMEOUT: 90000,
      BATCH_TIMEOUT: '45000',
    } as unknown as Env;
    const config = getTimeoutConfig(env);
    expect(config.geocoding).toBe(15000);
    expect(config.lookup).toBe(8000);
    expect(config.batch).toBe(45000);
    expect(config.total).toBe(90000);
  });
});

describe('getRetryConfig', () => {
  it('returns default retry config', () => {
    const config = getRetryConfig();
    expect(config.maxAttempts).toBe(RETRY_CONFIG.maxAttempts);
    expect(config.baseDelay).toBe(RETRY_CONFIG.baseDelay);
    expect(config.maxDelay).toBe(RETRY_CONFIG.maxDelay);
    expect(config.backoffMultiplier).toBe(RETRY_CONFIG.backoffMultiplier);
    expect(config.jitter).toBe(RETRY_CONFIG.jitter);
  });
});

describe('constants', () => {
  it('has correct time constants', () => {
    expect(TIME_CONSTANTS.ONE_HOUR_MS).toBe(60 * 60 * 1000);
    expect(TIME_CONSTANTS.SIX_HOURS_MS).toBe(6 * 60 * 60 * 1000);
    expect(TIME_CONSTANTS.TWENTY_FOUR_HOURS_MS).toBe(24 * 60 * 60 * 1000);
    expect(TIME_CONSTANTS.SEVEN_DAYS_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('has correct TTL constants', () => {
    expect(TIME_CONSTANTS_SECONDS.TWENTY_FOUR_HOURS).toBe(24 * 60 * 60);
  });

  it('has correct quality thresholds', () => {
    expect(QUALITY_THRESHOLDS.GEOGRATIS_MIN_SCORE).toBe(0.5);
  });
});
