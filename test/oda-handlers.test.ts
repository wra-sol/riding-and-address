/**
 * ODA handler tests.
 * @typescript-eslint/no-explicit-any is disabled for test mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

import {
  handleOdaInit,
  handleOdaStats,
  handleGeocodeRoute,
  handleReverseRoute,
  handleNormalizeAddressRoute,
  resolveNormalizedAddress,
} from '../src/oda-handlers';

import * as odaSchema from '../src/oda-schema';
import * as odaConfig from '../src/oda-config';
import * as odaGeocoding from '../src/oda-geocoding';
import * as utils from '../src/utils';
import * as geocoding from '../src/geocoding';

describe('ODA Handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleOdaInit', () => {
    it('initializes the ODA database when enabled', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(odaSchema, 'initializeOdaDatabase').mockResolvedValue(true);
      const env = {} as Env;
      const res = await handleOdaInit(env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
      expect(odaSchema.initializeOdaDatabase).toHaveBeenCalled();
    });

    it('returns 200 with success false when initialization fails', async () => {
      vi.spyOn(odaSchema, 'initializeOdaDatabase').mockResolvedValue(false);
      const env = {} as Env;
      const res = await handleOdaInit(env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(false);
    });
  });

  describe('handleOdaStats', () => {
    it('returns stats when enabled', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(odaSchema, 'getOdaStats').mockResolvedValue({
        enabled: true,
        provinces: { ON: { addressCount: 100 } },
        postalCentroids: 50,
        cityCentroids: 20,
        streetRanges: 500,
        imports: [],
      });
      const env = {} as Env;
      const res = await handleOdaStats(env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean };
      expect(body.enabled).toBe(true);
    });

    it('returns stats even when ODA is disabled', async () => {
      vi.spyOn(odaSchema, 'getOdaStats').mockResolvedValue({
        enabled: false,
        provinces: {},
        postalCentroids: 0,
        cityCentroids: 0,
        streetRanges: 0,
        imports: [],
      });
      const env = {} as Env;
      const res = await handleOdaStats(env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean };
      expect(body.enabled).toBe(false);
    });
  });

  describe('handleGeocodeRoute', () => {
    it('returns 503 when ODA is disabled and query is valid', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(false);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: { address: 'test' }, validation: { valid: true, sanitized: { address: 'test' } } } as any);
      const env = {} as Env;
      const res = await handleGeocodeRoute(new Request('http://test'), env);
      expect(res.status).toBe(503);
    });

    it('returns 400 when query is invalid', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: {}, validation: { valid: false, error: 'Missing address' } } as any);
      const env = {} as Env;
      const res = await handleGeocodeRoute(new Request('http://test'), env);
      expect(res.status).toBe(400);
    });

    it('returns geocode result on success', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: { address: '123 Main St', city: 'Toronto', state: 'ON' }, validation: { valid: true, sanitized: { address: '123 Main St', city: 'Toronto', state: 'ON' } } } as any);
      vi.spyOn(odaGeocoding, 'geocodeWithOda').mockResolvedValue({
        lon: -79.38, lat: 43.65, normalizedAddress: '123 Main St, Toronto, ON', confidence: 0.95,
      } as any);
      const env = {} as Env;
      const res = await handleGeocodeRoute(new Request('http://test'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { point: { lon: number } };
      expect(body.point.lon).toBe(-79.38);
    });
  });

  describe('handleReverseRoute', () => {
    it('returns 503 when disabled and query is valid', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(false);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: { lat: 43.65, lon: -79.38 }, validation: { valid: true, sanitized: { lat: 43.65, lon: -79.38 } } } as any);
      const env = {} as Env;
      const res = await handleReverseRoute(new Request('http://test?lat=43.65&lon=-79.38'), env);
      expect(res.status).toBe(503);
    });

    it('returns 400 when lat/lon are missing', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: {}, validation: { valid: false, error: 'Missing lat/lon' } } as any);
      const env = {} as Env;
      const res = await handleReverseRoute(new Request('http://test'), env);
      expect(res.status).toBe(400);
    });

    it('returns reverse geocode result', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: { lat: 43.65, lon: -79.38 }, validation: { valid: true, sanitized: { lat: 43.65, lon: -79.38 } } } as any);
      vi.spyOn(odaGeocoding, 'reverseGeocodeWithOda').mockResolvedValue({
        lon: -79.38, lat: 43.65, normalizedAddress: '123 Main St, Toronto, ON', confidence: 0.92,
      } as any);
      const env = {} as Env;
      const res = await handleReverseRoute(new Request('http://test?lat=43.65&lon=-79.38'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { normalizedAddress: string };
      expect(body.normalizedAddress).toBe('123 Main St, Toronto, ON');
    });
  });

  describe('handleNormalizeAddressRoute', () => {
    it('returns 503 when disabled and query is valid', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(false);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: { address: 'test' }, validation: { valid: true, sanitized: { address: 'test' } } } as any);
      const env = {} as Env;
      const res = await handleNormalizeAddressRoute(new Request('http://test'), env);
      expect(res.status).toBe(503);
    });

    it('returns 400 when query is invalid', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: {}, validation: { valid: false, error: 'Missing address' } } as any);
      const env = {} as Env;
      const res = await handleNormalizeAddressRoute(new Request('http://test'), env);
      expect(res.status).toBe(400);
    });

    it('returns normalized address', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(utils, 'parseQuery').mockReturnValue({ query: { address: '123 main st' }, validation: { valid: true, sanitized: { address: '123 main st' } } } as any);
      vi.spyOn(odaGeocoding, 'normalizeAddressWithOda').mockResolvedValue({
        lon: -79.38, lat: 43.65, normalizedAddress: '123 Main St', confidence: 0.9,
      } as any);
      const env = {} as Env;
      const res = await handleNormalizeAddressRoute(new Request('http://test'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { normalizedAddress: string };
      expect(body.normalizedAddress).toBe('123 Main St');
    });
  });

  describe('resolveNormalizedAddress', () => {
    it('uses ODA reverse geocode when ODA is enabled', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(odaGeocoding, 'reverseGeocodeWithOda').mockResolvedValue({
        lon: -79.38, lat: 43.65, normalizedAddress: '123 Main St, Toronto, ON',
      } as any);
      const env = {} as Env;
      const result = await resolveNormalizedAddress(env, 43.65, -79.38, { address: '123 main st' });
      expect(result?.normalizedAddress).toBe('123 Main St, Toronto, ON');
    });

    it('falls back to Google normalization when ODA reverse geocode fails', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(true);
      vi.spyOn(odaGeocoding, 'reverseGeocodeWithOda').mockRejectedValue(new Error('ODA down'));
      vi.spyOn(geocoding, 'normalizeAddressWithGoogle').mockResolvedValue({
        street: '456 Queen St', city: 'Ottawa', province: 'ON',
      } as any);
      const env = {} as Env;
      const result = await resolveNormalizedAddress(env, 43.65, -79.38, { address: '456 queen st' });
      expect(result?.normalizedAddress).toBeUndefined();
    });

    it('returns undefined when no address is provided and ODA is disabled', async () => {
      vi.spyOn(odaConfig, 'isOdaEnabled').mockReturnValue(false);
      const env = {} as Env;
      const result = await resolveNormalizedAddress(env, 43.65, -79.38, {});
      expect(result).toBeUndefined();
    });
  });
});
