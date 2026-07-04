import { describe, it, expect } from 'vitest';
import {
  prepareOdaInsertRow,
  escapeSql,
  buildAddressInsertSql,
  accumulateCentroid,
  buildCentroidSqlStatements,
  trackCentroidsFromRow,
  PROVINCE_DOWNLOAD_URLS,
  SUPPORTED_ODA_PROVINCES,
} from '../src/oda-import';
import type { NormalizedOdaRow } from '../src/oda-normalize';
import type { CentroidAccumulator } from '../src/oda-import';

function makeRow(partial: Partial<NormalizedOdaRow> = {}): NormalizedOdaRow {
  const base: NormalizedOdaRow = {
    province: 'ON',
    civicNumber: '123',
    streetName: 'Main',
    streetType: 'St',
    streetDirection: '',
    unit: '',
    postalCode: 'M5V 2T6',
    city: 'Toronto',
    cityKey: 'TORONTO|ON',
    lat: 43.65,
    lon: -79.38,
    fullAddress: '123 Main St, Toronto, ON',
    searchKey: '123 main st toronto',
    streetKey: 'main st',
  };
  return { ...base, ...partial };
}

describe('prepareOdaInsertRow', () => {
  it('formats a complete row into mailing address components', () => {
    const row = makeRow({
      streetDirection: 'E',
      unit: 'Apt 4',
    });

    const result = prepareOdaInsertRow(row);
    // Canada Post format puts unit on line1 and civic/street on line2
    expect(result.mailingLine1).toBe('APT 4');
    expect(result.mailingLine2).toBe('123 MAIN ST E');
    expect(result.municipality).toBe('TORONTO');
    expect(result.provinceCode).toBe('ON');
    expect(result.mailingPostalCode).toBe('M5V 2T6');
  });

  it('handles rows without optional directional or unit fields', () => {
    const row = makeRow({
      province: 'BC',
      civicNumber: '456',
      streetName: 'Oak',
      streetType: 'Ave',
      city: 'Vancouver',
      cityKey: 'VANCOUVER|BC',
      lat: 49.28,
      lon: -123.12,
      fullAddress: '456 Oak Ave, Vancouver, BC',
      searchKey: '456 oak ave vancouver',
      streetKey: 'oak ave',
    });

    const result = prepareOdaInsertRow(row);
    // foldAccents uppercases everything
    expect(result.mailingLine1).toBe('456 OAK AVE');
    expect(result.mailingLine2).toBeUndefined();
    expect(result.unit).toBe('');
    expect(result.streetDirection).toBe('');
  });
});

describe('escapeSql', () => {
  it('returns quoted string for regular text', () => {
    expect(escapeSql('hello')).toBe("'hello'");
  });

  it('escapes single quotes by doubling them', () => {
    expect(escapeSql("it's")).toBe("'it''s'");
  });

  it('returns empty quote for null', () => {
    expect(escapeSql(null)).toBe("''");
  });

  it('returns empty quote for undefined', () => {
    expect(escapeSql(undefined)).toBe("''");
  });

  it('returns number as string for finite numbers', () => {
    expect(escapeSql(42)).toBe('42');
    expect(escapeSql(-3.14)).toBe('-3.14');
  });

  it('returns NULL for non-finite numbers', () => {
    expect(escapeSql(NaN)).toBe('NULL');
    expect(escapeSql(Infinity)).toBe('NULL');
  });
});

describe('buildAddressInsertSql', () => {
  it('generates a valid INSERT statement', () => {
    const row = prepareOdaInsertRow(makeRow({
      civicNumber: '1',
      streetName: 'Queen',
      streetType: 'St',
      city: 'Ottawa',
      cityKey: 'OTTAWA|ON',
      lat: 45.42,
      lon: -75.7,
      fullAddress: '1 Queen St, Ottawa, ON',
      searchKey: '1 queen st ottawa',
      streetKey: 'queen st',
    }));

    const sql = buildAddressInsertSql(row, 1);
    expect(sql).toContain('INSERT INTO oda_addresses');
    expect(sql).toContain("VALUES (\n    1, 'ON', '1', 'Queen',");
    expect(sql).toContain("'1 Queen St, Ottawa, ON'");
    expect(sql).toContain('45.42');
    expect(sql).toContain('-75.7');
  });
});

describe('accumulateCentroid', () => {
  it('accumulates lat/lon and count', () => {
    const acc = accumulateCentroid(
      { latSum: 0, lonSum: 0, count: 0, minCivic: null, maxCivic: null } as CentroidAccumulator,
      10,
      20
    );
    expect(acc.latSum).toBe(10);
    expect(acc.lonSum).toBe(20);
    expect(acc.count).toBe(1);
  });

  it('tracks min and max civic numbers', () => {
    let acc: CentroidAccumulator = { latSum: 0, lonSum: 0, count: 0, minCivic: null, maxCivic: null };
    acc = accumulateCentroid(acc, 0, 0, '100');
    acc = accumulateCentroid(acc, 0, 0, '50');
    acc = accumulateCentroid(acc, 0, 0, '200');
    expect(acc.minCivic).toBe(50);
    expect(acc.maxCivic).toBe(200);
  });

  it('ignores non-numeric civic numbers', () => {
    const acc = accumulateCentroid(
      { latSum: 0, lonSum: 0, count: 0, minCivic: null, maxCivic: null } as CentroidAccumulator,
      0, 0, 'abc'
    );
    expect(acc.minCivic).toBeNull();
    expect(acc.maxCivic).toBeNull();
  });
});

describe('buildCentroidSqlStatements', () => {
  it('generates statements for all centroid types', () => {
    const postalCentroids = new Map([
      ['M5V 2T6', { latSum: 43.6, lonSum: -79.4, count: 2, minCivic: 10, maxCivic: 20 }],
    ]);
    const cityCentroids = new Map([
      ['toronto|on', { latSum: 43.6, lonSum: -79.4, count: 2, minCivic: 10, maxCivic: 20, city: 'Toronto' }],
    ]);
    const streetRanges = new Map([
      [
        'toronto|on|main st',
        { latSum: 43.6, lonSum: -79.4, count: 2, minCivic: 10, maxCivic: 20, streetKey: 'main st', cityKey: 'toronto|on' },
      ],
    ]);

    const statements = buildCentroidSqlStatements('ON', postalCentroids, cityCentroids, streetRanges);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('oda_postal_centroids');
    expect(statements[1]).toContain('oda_city_centroids');
    expect(statements[2]).toContain('oda_street_ranges');
    expect(statements[0]).toContain('M5V 2T6');
  });
});

describe('trackCentroidsFromRow', () => {
  it('populates postal, city, and street centroids from a row', () => {
    const postalCentroids = new Map();
    const cityCentroids = new Map();
    const streetRanges = new Map();

    const row = makeRow({
      civicNumber: '100',
      postalCode: 'M5V 2T6',
      city: 'Toronto',
      cityKey: 'TORONTO|ON',
      lat: 43.65,
      lon: -79.38,
    });

    trackCentroidsFromRow(row, postalCentroids, cityCentroids, streetRanges);

    expect(postalCentroids.has('M5V 2T6')).toBe(true);
    expect(cityCentroids.has('TORONTO|ON')).toBe(true);
    expect(streetRanges.has('TORONTO|ON|main st')).toBe(true);

    const postal = postalCentroids.get('M5V 2T6');
    expect(postal.count).toBe(1);
    expect(postal.latSum).toBe(43.65);
  });
});

describe('province constants', () => {
  it('has download URLs for all supported provinces', () => {
    expect(Object.keys(PROVINCE_DOWNLOAD_URLS).sort()).toEqual([...SUPPORTED_ODA_PROVINCES]);
  });

  it('includes Ontario', () => {
    expect(PROVINCE_DOWNLOAD_URLS.ON).toContain('ODA_ON_v1.zip');
  });
});
