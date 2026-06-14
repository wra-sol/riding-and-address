import { describe, it, expect, beforeEach } from 'vitest';
import { geoCacheLRU, spatialIndexCacheLRU } from '../src/cache';
import {
  createLookupTestEnv,
  fetchLookup,
  TORONTO_LAT,
  TORONTO_LON,
} from './helpers/lookup-test-env';

describe('lookup API integration (PR manual test plan)', () => {
  beforeEach(() => {
    geoCacheLRU.clear();
    spatialIndexCacheLRU.clear();
  });

  it('GET /api/combined returns province_data for Ontario coordinates', async () => {
    const env = createLookupTestEnv();
    const response = await fetchLookup(
      env,
      `/api/combined?lat=${TORONTO_LAT}&lon=${TORONTO_LON}`
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      province_data?: { riding: string; properties: Record<string, unknown> };
      query: { includeProvince?: boolean };
    };

    expect(body.query.includeProvince).toBe(true);
    expect(body.province_data).not.toBeNull();
    expect(body.province_data?.riding).toBe('Toronto Centre');
    expect(body.province_data?.properties?.PR_NUM).toBe('082');
  });

  it('GET /api/federal?include_province=true returns province_data', async () => {
    const env = createLookupTestEnv();
    const response = await fetchLookup(
      env,
      `/api/federal?lat=${TORONTO_LAT}&lon=${TORONTO_LON}&include_province=true`
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      province_data?: { riding: string; properties: Record<string, unknown> };
      query: { includeProvince?: boolean };
    };

    expect(body.query.includeProvince).toBe(true);
    expect(body.province_data).not.toBeNull();
    expect(body.province_data?.riding).toBe('Toronto Centre');
  });

  it('GET /api/federal?return=municipality returns municipality and properties.MUNICIPALITY', async () => {
    const env = createLookupTestEnv();
    const response = await fetchLookup(
      env,
      `/api/federal?lat=${TORONTO_LAT}&lon=${TORONTO_LON}&return=municipality&city=Toronto`
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      municipality?: string;
      properties?: { MUNICIPALITY?: string; ED_NAMEE?: string };
      query: { returnFields?: string[] };
    };

    expect(body.query.returnFields).toEqual(['municipality']);
    expect(body.municipality).toBe('Toronto');
    expect(body.properties?.MUNICIPALITY).toBe('Toronto');
    expect(body.properties?.ED_NAMEE).toBe('Spadina—Harbourfront');
  });

  it('POST /batch supports include_province and return fields', async () => {
    const env = createLookupTestEnv();
    const response = await fetchLookup(env, '/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            id: 'combined-municipality',
            pathname: '/api/combined',
            query: {
              lat: TORONTO_LAT,
              lon: TORONTO_LON,
              return: 'municipality',
              city: 'Toronto',
            },
          },
          {
            id: 'federal-province',
            pathname: '/api/federal',
            query: {
              lat: TORONTO_LAT,
              lon: TORONTO_LON,
              include_province: 'true',
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{
        id: string;
        municipality?: string;
        properties?: { MUNICIPALITY?: string };
        province_data?: { riding: string } | null;
        query: { includeProvince?: boolean; returnFields?: string[] };
      }>;
    };

    expect(body.results).toHaveLength(2);

    const combined = body.results.find((r) => r.id === 'combined-municipality');
    expect(combined?.query.includeProvince).toBe(true);
    expect(combined?.query.returnFields).toEqual(['municipality']);
    expect(combined?.municipality).toBe('Toronto');
    expect(combined?.properties?.MUNICIPALITY).toBe('Toronto');
    expect(combined?.province_data?.riding).toBe('Toronto Centre');

    const federal = body.results.find((r) => r.id === 'federal-province');
    expect(federal?.query.includeProvince).toBe(true);
    expect(federal?.province_data?.riding).toBe('Toronto Centre');
  });
});
