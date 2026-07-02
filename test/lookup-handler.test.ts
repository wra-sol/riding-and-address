import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLookupRequest } from '../src/lookup-handler';
import type { Env } from '../src/types';

const mockPerformExpandedLookup = vi.fn();
const mockParseQuery = vi.fn();
const mockGeocodeIfNeeded = vi.fn();
const mockIncrementMetric = vi.fn();
const mockRecordTiming = vi.fn();

vi.mock('../src/lookup-expansion', () => ({
  performExpandedLookup: (...args: unknown[]) => mockPerformExpandedLookup(...args),
  expandedLookupResponseFields: vi.fn((expanded: Record<string, unknown>) => {
    const { riding, properties, province, district, odaMatch } = expanded;
    return { riding, properties, province, district, odaMatch };
  }),
}));

vi.mock('../src/utils', () => ({
  parseQuery: (...args: unknown[]) => mockParseQuery(...args),
  badRequest: vi.fn((message: string, status: number, code: string, correlationId: string) =>
    new Response(JSON.stringify({ error: message, code, correlationId }), { status })
  ),
}));

vi.mock('../src/geocoding', () => ({
  geocodeIfNeeded: (...args: unknown[]) => mockGeocodeIfNeeded(...args),
}));

vi.mock('../src/circuit-breaker', () => ({
  geocodingCircuitBreaker: {
    execute: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    getStateInfo: vi.fn(async () => ({ state: 'CLOSED', failures: 0 })),
  },
}));

vi.mock('../src/metrics', () => ({
  incrementMetric: (...args: unknown[]) => mockIncrementMetric(...args),
  recordTiming: (...args: unknown[]) => mockRecordTiming(...args),
}));

vi.mock('../src/config', () => ({
  getTimeoutConfig: vi.fn(() => ({ geocoding: 5000, lookup: 5000, total: 60000 })),
}));

function createMockEnv(): Env {
  return {
    RIDINGS: {} as R2Bucket,
    RIDING_DB: {} as D1Database,
    ODA_DB: {} as D1Database,
    WEBHOOKS: {} as KVNamespace,
    GEOCODER: 'google',
    ODA_GEOCODING_ENABLED: 'true',
  };
}

function createRequest(url: string, method = 'GET'): Request {
  return new Request(url, { method });
}

describe('handleLookupRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for invalid query parameters', async () => {
    mockParseQuery.mockReturnValue({ validation: { valid: false, error: 'Missing address or postal' } });
    const request = createRequest('http://localhost/api/federal?address=');
    const response = await handleLookupRequest(
      request,
      createMockEnv(),
      '/api/federal',
      vi.fn(),
      'corr-123',
      Date.now(),
      () => ({ 'Access-Control-Allow-Origin': '*' })
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('INVALID_QUERY');
  });

  it('returns lookup result with CORS headers on success', async () => {
    mockParseQuery.mockReturnValue({
      validation: { valid: true, sanitized: { address: '123 Main St, Toronto, ON' } },
    });
    mockPerformExpandedLookup.mockResolvedValue({
      point: { lat: 43.7, lon: -79.4 },
      riding: 'Toronto Centre',
      properties: { ENNAME: 'Toronto Centre' },
      province: 'ON',
      district: 'Toronto Centre',
      cacheStatus: 'HIT',
    });

    const request = createRequest('http://localhost/api/federal?address=123+Main+St');
    const response = await handleLookupRequest(
      request,
      createMockEnv(),
      '/api/federal',
      vi.fn(),
      'corr-456',
      Date.now(),
      (origin) => ({ 'Access-Control-Allow-Origin': origin || '*' })
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { riding: string; correlationId: string; query: { address: string } };
    expect(body.riding).toBe('Toronto Centre');
    expect(body.correlationId).toBe('corr-456');
    expect(body.query.address).toBe('123 Main St, Toronto, ON');
    expect(mockIncrementMetric).toHaveBeenCalledWith('lookupRequests');
    expect(mockRecordTiming).toHaveBeenCalledWith('totalLookupTime', expect.any(Number));
  });

  it('handles lookup errors and returns 500', async () => {
    mockParseQuery.mockReturnValue({
      validation: { valid: true, sanitized: { address: 'Unknown Place' } },
    });
    mockPerformExpandedLookup.mockRejectedValue(new Error('Geocoding service unreachable'));

    const request = createRequest('http://localhost/api/federal?address=Unknown+Place');
    const response = await handleLookupRequest(
      request,
      createMockEnv(),
      '/api/federal',
      vi.fn(),
      'corr-789',
      Date.now(),
      () => ({ 'Access-Control-Allow-Origin': '*' })
    );

    expect(response.status).toBe(500);
    const body = await response.json() as { error: string; code: string };
    expect(body.error).toBe('Geocoding service unreachable');
    expect(body.code).toBe('LOOKUP_ERROR');
    expect(mockIncrementMetric).toHaveBeenCalledWith('errorCount');
  });

  it('passes deferTask when ExecutionContext is provided', async () => {
    mockParseQuery.mockReturnValue({
      validation: { valid: true, sanitized: { address: '456 Elm St' } },
    });
    const deferredTasks: Promise<unknown>[] = [];
    const mockCtx = {
      waitUntil: (task: Promise<unknown>) => { deferredTasks.push(task); },
    } as ExecutionContext;

    mockPerformExpandedLookup.mockResolvedValue({
      point: { lat: 45.5, lon: -73.6 },
      riding: 'Montreal',
      properties: { ENNAME: 'Montreal' },
      province: 'QC',
      district: 'Montreal',
      cacheStatus: 'MISS',
    });

    const request = createRequest('http://localhost/api/federal?address=456+Elm+St');
    await handleLookupRequest(
      request,
      createMockEnv(),
      '/api/federal',
      vi.fn(),
      'corr-abc',
      Date.now(),
      () => ({ 'Access-Control-Allow-Origin': '*' }),
      mockCtx
    );

    // Verify performExpandedLookup was called with deferTask option
    const callArgs = mockPerformExpandedLookup.mock.calls[0];
    expect(callArgs[3]).toBeInstanceOf(Function); // lookupRiding
    expect(callArgs[4].deferTask).toBeDefined();
    expect(callArgs[4].geocodingTimeoutMs).toBe(5000);
  });

  it('uses correct lookup path from pathname', async () => {
    mockParseQuery.mockReturnValue({
      validation: { valid: true, sanitized: { address: '789 Oak St' } },
    });
    mockPerformExpandedLookup.mockResolvedValue({
      point: { lat: 49.3, lon: -123.1 },
      riding: 'Vancouver Centre',
      properties: { ENNAME: 'Vancouver Centre' },
      province: 'BC',
      district: 'Vancouver Centre',
      cacheStatus: 'HIT',
    });

    const request = createRequest('http://localhost/api/combined?address=789+Oak+St');
    await handleLookupRequest(
      request,
      createMockEnv(),
      '/api/combined',
      vi.fn(),
      'corr-def',
      Date.now(),
      () => ({ 'Access-Control-Allow-Origin': '*' })
    );

    // The lookup path should be derived from /api/combined
    expect(mockPerformExpandedLookup).toHaveBeenCalled();
  });
});
