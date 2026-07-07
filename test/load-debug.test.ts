import { describe, it, expect } from 'vitest';
import * as odaConfig from '../src/oda-config';

describe('load debug', () => {
  it('checks module loaded', () => {
    expect(Object.keys(odaConfig)).toContain('isOdaEnabled');
    console.log('odaConfig.isOdaEnabled:', odaConfig.isOdaEnabled);
    console.log('odaConfig.isOdaEnabled name:', odaConfig.isOdaEnabled.name);
  });
});
