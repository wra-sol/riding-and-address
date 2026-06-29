import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  incrementMetric,
  recordTiming,
  updateOdaD1QueriesMaxPerRequest,
  getMetrics,
  resetMetrics,
  getMetricsAge,
  getMetricsSummary,
} from '../src/metrics';
import { TIME_CONSTANTS } from '../src/config';
import type { Metrics } from '../src/types';

describe('metrics', () => {
  beforeEach(() => {
    resetMetrics();
    vi.useFakeTimers();
    // Set a stable baseline time so lastResetTime is deterministic
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    resetMetrics(); // reset again after setting fake time so lastResetTime aligns
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('incrementMetric', () => {
    it('increments a metric by 1 by default', () => {
      incrementMetric('requestCount');
      expect(getMetrics().requestCount).toBe(1);
    });

    it('increments a metric by the given value', () => {
      incrementMetric('geocodingRequests', 5);
      expect(getMetrics().geocodingRequests).toBe(5);
    });

    it('accumulates across multiple calls', () => {
      incrementMetric('r2Requests');
      incrementMetric('r2Requests');
      incrementMetric('r2Requests', 3);
      expect(getMetrics().r2Requests).toBe(5);
    });

    it('works with all numeric metric keys', () => {
      const keys: (keyof Metrics)[] = [
        'geocodingCacheHits',
        'geocodingCacheMisses',
        'geocodingErrors',
        'geocodingSuccesses',
        'geocodingFailures',
        'geocodingCircuitBreakerTrips',
        'r2CacheHits',
        'r2CacheMisses',
        'r2Errors',
        'r2Successes',
        'r2Failures',
        'r2CircuitBreakerTrips',
        'spatialIndexHits',
        'spatialIndexMisses',
        'lookupCacheHits',
        'lookupCacheMisses',
        'lookupErrors',
        'batchErrors',
        'webhookDeliveries',
        'webhookFailures',
        'errorCount',
        'odaD1Reads',
        'odaStageTimeouts',
      ];
      for (const key of keys) {
        incrementMetric(key, 2);
        expect(getMetrics()[key]).toBe(2);
      }
    });
  });

  describe('recordTiming', () => {
    it('adds duration to a timing metric', () => {
      recordTiming('totalGeocodingTime', 150);
      expect(getMetrics().totalGeocodingTime).toBe(150);
    });

    it('accumulates timing across calls', () => {
      recordTiming('totalLookupTime', 100);
      recordTiming('totalLookupTime', 200);
      recordTiming('totalLookupTime', 50);
      expect(getMetrics().totalLookupTime).toBe(350);
    });

    it('works with all timing keys', () => {
      const timingKeys: (keyof Metrics)[] = [
        'totalSpatialIndexTime',
        'totalLookupTime',
        'totalGeocodingTime',
        'geocodingOdaTime',
        'geocodingGeoGratisTime',
        'geocodingFallbackTime',
        'totalR2Time',
        'totalBatchTime',
        'totalWebhookTime',
      ];
      for (const key of timingKeys) {
        recordTiming(key, 42);
        expect(getMetrics()[key]).toBe(42);
      }
    });
  });

  describe('updateOdaD1QueriesMaxPerRequest', () => {
    it('sets the max when it is higher than the current value', () => {
      updateOdaD1QueriesMaxPerRequest(5);
      expect(getMetrics().odaD1QueriesMaxPerRequest).toBe(5);

      updateOdaD1QueriesMaxPerRequest(10);
      expect(getMetrics().odaD1QueriesMaxPerRequest).toBe(10);
    });

    it('does not decrease the max when a lower value is given', () => {
      updateOdaD1QueriesMaxPerRequest(10);
      updateOdaD1QueriesMaxPerRequest(3);
      expect(getMetrics().odaD1QueriesMaxPerRequest).toBe(10);
    });

    it('starts at zero', () => {
      expect(getMetrics().odaD1QueriesMaxPerRequest).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('returns a copy of the metrics object', () => {
      incrementMetric('requestCount', 3);
      const snapshot = getMetrics();
      snapshot.requestCount = 999;
      // Mutating the snapshot should not affect the internal state
      expect(getMetrics().requestCount).toBe(3);
    });

    it('includes all metric keys', () => {
      const m = getMetrics();
      expect(m).toHaveProperty('geocodingRequests');
      expect(m).toHaveProperty('requestCount');
      expect(m).toHaveProperty('odaD1QueriesMaxPerRequest');
      expect(m).toHaveProperty('totalWebhookTime');
    });
  });

  describe('resetMetrics', () => {
    it('resets all metrics to zero', () => {
      incrementMetric('requestCount', 10);
      incrementMetric('geocodingErrors', 5);
      recordTiming('totalR2Time', 500);
      updateOdaD1QueriesMaxPerRequest(7);

      resetMetrics();

      const m = getMetrics();
      expect(m.requestCount).toBe(0);
      expect(m.geocodingErrors).toBe(0);
      expect(m.totalR2Time).toBe(0);
      expect(m.odaD1QueriesMaxPerRequest).toBe(0);
    });
  });

  describe('getMetricsAge', () => {
    it('returns zero immediately after reset', () => {
      resetMetrics();
      expect(getMetricsAge()).toBe(0);
    });

    it('returns elapsed milliseconds since last reset', () => {
      resetMetrics();
      vi.advanceTimersByTime(5000);
      expect(getMetricsAge()).toBe(5000);
    });
  });

  describe('auto-reset (24h window)', () => {
    it('does not reset before 24 hours have passed', () => {
      incrementMetric('requestCount', 10);
      vi.advanceTimersByTime(TIME_CONSTANTS.TWENTY_FOUR_HOURS_MS - 1);
      incrementMetric('requestCount', 1);
      expect(getMetrics().requestCount).toBe(11);
    });

    it('resets metrics after 24 hours have passed', () => {
      incrementMetric('requestCount', 10);
      vi.advanceTimersByTime(TIME_CONSTANTS.TWENTY_FOUR_HOURS_MS);
      incrementMetric('requestCount', 1);
      // After reset + the new increment, requestCount should be 1
      expect(getMetrics().requestCount).toBe(1);
    });

    it('resets timing metrics after 24 hours', () => {
      recordTiming('totalGeocodingTime', 1000);
      vi.advanceTimersByTime(TIME_CONSTANTS.TWENTY_FOUR_HOURS_MS);
      recordTiming('totalGeocodingTime', 50);
      expect(getMetrics().totalGeocodingTime).toBe(50);
    });
  });

  describe('getMetricsSummary', () => {
    it('returns zeroed summary when no metrics recorded', () => {
      const summary = getMetricsSummary();
      expect(summary.requests.total).toBe(0);
      expect(summary.requests.errorRate).toBe(0);
      expect(summary.geocoding.hitRate).toBe(0);
      expect(summary.geocoding.avgTime).toBe(0);
      expect(summary.r2.hitRate).toBe(0);
      expect(summary.lookup.hitRate).toBe(0);
      expect(summary.batch.avgTime).toBe(0);
      expect(summary.webhooks.successRate).toBe(0);
    });

    it('computes request error rate', () => {
      incrementMetric('requestCount', 100);
      incrementMetric('errorCount', 5);
      const summary = getMetricsSummary();
      expect(summary.requests.total).toBe(100);
      expect(summary.requests.errors).toBe(5);
      expect(summary.requests.errorRate).toBe(5);
    });

    it('computes geocoding cache hit rate and average time', () => {
      incrementMetric('geocodingRequests', 10);
      incrementMetric('geocodingCacheHits', 3);
      incrementMetric('geocodingCacheMisses', 7);
      recordTiming('totalGeocodingTime', 500);
      const summary = getMetricsSummary();
      expect(summary.geocoding.requests).toBe(10);
      expect(summary.geocoding.cacheHits).toBe(3);
      expect(summary.geocoding.cacheMisses).toBe(7);
      expect(summary.geocoding.hitRate).toBe(30);
      expect(summary.geocoding.avgTime).toBe(50);
    });

    it('computes r2 cache hit rate and average time', () => {
      incrementMetric('r2Requests', 20);
      incrementMetric('r2CacheHits', 8);
      recordTiming('totalR2Time', 400);
      const summary = getMetricsSummary();
      expect(summary.r2.requests).toBe(20);
      expect(summary.r2.cacheHits).toBe(8);
      expect(summary.r2.hitRate).toBe(40);
      expect(summary.r2.avgTime).toBe(20);
    });

    it('computes lookup cache hit rate and average time', () => {
      incrementMetric('lookupRequests', 50);
      incrementMetric('lookupCacheHits', 25);
      recordTiming('totalLookupTime', 1000);
      const summary = getMetricsSummary();
      expect(summary.lookup.requests).toBe(50);
      expect(summary.lookup.hitRate).toBe(50);
      expect(summary.lookup.avgTime).toBe(20);
    });

    it('computes batch average time', () => {
      incrementMetric('batchRequests', 4);
      recordTiming('totalBatchTime', 800);
      const summary = getMetricsSummary();
      expect(summary.batch.requests).toBe(4);
      expect(summary.batch.avgTime).toBe(200);
    });

    it('computes webhook success rate and average time', () => {
      incrementMetric('webhookDeliveries', 8);
      incrementMetric('webhookFailures', 2);
      recordTiming('totalWebhookTime', 1000);
      const summary = getMetricsSummary();
      expect(summary.webhooks.deliveries).toBe(8);
      expect(summary.webhooks.failures).toBe(2);
      expect(summary.webhooks.successRate).toBe(80);
      expect(summary.webhooks.avgTime).toBe(100);
    });

    it('handles zero requests without division by zero', () => {
      // Only errors, no requests — errorRate should be 0
      incrementMetric('errorCount', 5);
      const summary = getMetricsSummary();
      expect(summary.requests.errorRate).toBe(0);
    });

    it('rounds to 2 decimal places', () => {
      incrementMetric('requestCount', 3);
      incrementMetric('errorCount', 1);
      const summary = getMetricsSummary();
      // 1/3 * 100 = 33.333... → rounded to 33.33
      expect(summary.requests.errorRate).toBe(33.33);
    });
  });
});
