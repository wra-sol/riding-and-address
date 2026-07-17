import { describe, it, expect, vi } from 'vitest';
import {
  getOdaBaseSchemaSql,
  getOdaSchemaSql,
  initializeOdaDatabase,
  getOdaStats,
  deleteProvinceData,
} from '../src/oda-schema';
import type { Env } from '../src/types';

function createMockD1(): D1Database {
  const calls: Array<{ sql: string; params: unknown[]; method: string }> = [];

  const mockStmt = (sql: string, params: unknown[] = []) => ({
    first: async () => {
      calls.push({ sql, params, method: 'first' });
      if (sql.includes('COUNT(*)')) return { count: 42 };
      return null;
    },
    all: async () => {
      calls.push({ sql, params, method: 'all' });
      if (sql.includes('oda_addresses')) {
        return {
          results: [
            { province: 'ON', count: 100 },
            { province: 'QC', count: 50 },
          ],
        };
      }
      if (sql.includes('oda_imports')) {
        return {
          results: [
            { province: 'ON', source_version: '2024', row_count: 100, started_at: '2024-01-01', finished_at: '2024-01-02' },
          ],
        };
      }
      return { results: [] };
    },
    run: async () => {
      calls.push({ sql, params, method: 'run' });
      return { success: true, results: [], meta: {} };
    },
    bind: (...bindParams: unknown[]) => mockStmt(sql, bindParams),
    raw: async () => {
      calls.push({ sql, params, method: 'raw' });
      return [];
    },
  });

  const db = {
    prepare: (sql: string) => mockStmt(sql),
    batch: async (stmts: unknown[]) => {
      for (const s of stmts) {
        if (typeof (s as Record<string, unknown>).run === 'function') {
          await (s as { run: () => Promise<unknown> }).run();
        }
      }
      return [];
    },
    calls,
  } as unknown as D1Database & { calls: typeof calls };

  return db;
}

describe('oda-schema', () => {
  describe('getOdaBaseSchemaSql', () => {
    it('returns DDL for all core tables', () => {
      const sql = getOdaBaseSchemaSql();
      expect(sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS oda_addresses'))).toBe(true);
      expect(sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS oda_postal_centroids'))).toBe(true);
      expect(sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS oda_city_centroids'))).toBe(true);
      expect(sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS oda_street_ranges'))).toBe(true);
      expect(sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS oda_imports'))).toBe(true);
    });

    it('returns index creation statements', () => {
      const sql = getOdaBaseSchemaSql();
      expect(sql.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_oda_postal'))).toBe(true);
      expect(sql.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_oda_street'))).toBe(true);
      expect(sql.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_oda_search'))).toBe(true);
    });
  });

  describe('getOdaSchemaSql', () => {
    it('delegates to getOdaBaseSchemaSql', () => {
      const base = getOdaBaseSchemaSql();
      const full = getOdaSchemaSql();
      expect(full).toEqual(base);
    });
  });

  describe('initializeOdaDatabase', () => {
    it('returns false when ODA_DB is missing', async () => {
      const env = {} as Env;
      const result = await initializeOdaDatabase(env);
      expect(result).toBe(false);
    });

    it('executes all schema statements and returns true', async () => {
      const mockDb = createMockD1();
      const env = { ODA_DB: mockDb } as Env;
      const result = await initializeOdaDatabase(env);
      expect(result).toBe(true);

      const runCalls = (mockDb as unknown as { calls: Array<{ method: string }> }).calls.filter((c) => c.method === 'run');
      expect(runCalls.length).toBe(getOdaSchemaSql().length);
    });

    it('returns false and logs on error', async () => {
      const failingDb = {
        prepare: () => ({
          run: async () => {
            throw new Error('D1 locked');
          },
        }),
      } as unknown as D1Database;

      const env = { ODA_DB: failingDb } as Env;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await initializeOdaDatabase(env);
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('Failed to initialize ODA database:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('getOdaStats', () => {
    it('returns disabled stats when ODA_DB is missing', async () => {
      const env = {} as Env;
      const stats = await getOdaStats(env);
      expect(stats.enabled).toBe(false);
      expect(stats.postalCentroids).toBe(0);
    });

    it('aggregates stats from ODA_DB', async () => {
      const mockDb = createMockD1();
      const env = { ODA_DB: mockDb } as Env;
      const stats = await getOdaStats(env);
      expect(stats.enabled).toBe(true);
      expect(stats.provinces.ON).toEqual({ addressCount: 100, lastImport: '2024-01-02' });
      expect(stats.provinces.QC).toEqual({ addressCount: 50 });
      expect(stats.imports).toHaveLength(1);
      expect(stats.postalCentroids).toBe(42);
      expect(stats.cityCentroids).toBe(42);
      expect(stats.streetRanges).toBe(42);
    });

    it('returns empty stats on error without throwing', async () => {
      const failingDb = {
        prepare: () => ({
          all: async () => {
            throw new Error('D1 down');
          },
          first: async () => {
            throw new Error('D1 down');
          },
        }),
      } as unknown as D1Database;

      const env = { ODA_DB: failingDb } as Env;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stats = await getOdaStats(env);
      expect(stats.enabled).toBe(true);
      expect(stats.provinces).toEqual({});
      expect(stats.postalCentroids).toBe(0);
      consoleSpy.mockRestore();
    });
  });

  describe('deleteProvinceData', () => {
    it('returns early when ODA_DB is missing', async () => {
      const env = {} as Env;
      await expect(deleteProvinceData(env, 'ON')).resolves.toBeUndefined();
    });

    it('deletes province data across all tables', async () => {
      const mockDb = createMockD1();
      const env = { ODA_DB: mockDb } as Env;
      await deleteProvinceData(env, 'ON');

      const runCalls = (mockDb as unknown as { calls: Array<{ sql: string; method: string }> }).calls.filter((c) => c.method === 'run');
      expect(runCalls.length).toBe(4);
      expect(runCalls[0]?.sql).toContain('DELETE FROM oda_addresses');
      expect(runCalls[1]?.sql).toContain('DELETE FROM oda_postal_centroids');
      expect(runCalls[2]?.sql).toContain('DELETE FROM oda_city_centroids');
      expect(runCalls[3]?.sql).toContain('DELETE FROM oda_street_ranges');
    });
  });
});
