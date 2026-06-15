import { describe, it, expect } from 'vitest';
import { getOdaConfig } from '../src/oda-config';
import { SUPPORTED_ODA_PROVINCES } from '../src/oda-import';
import type { Env } from '../src/types';

describe('getOdaConfig', () => {
  it('parses all 10 StatCan ODA province codes', () => {
    const env = {
      ODA_GEOCODING_ENABLED: 'true',
      ODA_PROVINCES: SUPPORTED_ODA_PROVINCES.join(','),
    } as Env;
    const config = getOdaConfig(env);
    expect(config.provinces).toEqual(SUPPORTED_ODA_PROVINCES);
    expect(config.provinces).toHaveLength(10);
  });

  it('defaults to ON and QC when ODA_PROVINCES unset', () => {
    const config = getOdaConfig({} as Env);
    expect(config.provinces).toEqual(['ON', 'QC']);
  });
});
