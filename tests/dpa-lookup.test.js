const { parseHwlResult } = require('../lib/dpa-lookup');

const hwlResponse = (dpaValue, mmmValue = 2, catchment = 'Gosford') => ({
  results: {
    dpa_gps: { features: [{ properties: { value: dpaValue, class: 'DPA', catchment } }] },
    dpa_bmp: { features: [{ properties: { value: 'N' } }] },
    mmm2023: { features: [{ properties: { value: mmmValue } }] },
  },
});

describe('parseHwlResult — the official Department of Health answer', () => {
  it('reads Y as in-DPA', () => {
    expect(parseHwlResult(hwlResponse('Y'))).toMatchObject({
      dpa: true, dpaCatchment: 'Gosford', dpaBonded: false, mmm: 'MM2',
    });
  });
  it('reads N as not-in-DPA', () => {
    expect(parseHwlResult(hwlResponse('N')).dpa).toBe(false);
  });
  it('is case and whitespace tolerant', () => {
    expect(parseHwlResult(hwlResponse(' y ')).dpa).toBe(true);
  });
  it('reads the bonded flag separately', () => {
    const r = hwlResponse('N');
    r.results.dpa_bmp.features[0].properties.value = 'Y';
    expect(parseHwlResult(r).dpaBonded).toBe(true);
  });
  it('names its source so the practice can check us', () => {
    expect(parseHwlResult(hwlResponse('Y')).source).toMatch(/Health Workforce Locator/i);
  });

  // The whole point: we must never invent an answer.
  it('THROWS rather than defaulting when the value is missing', () => {
    expect(() => parseHwlResult({ results: { dpa_gps: { features: [] } } })).toThrow();
  });
  it('THROWS on an unexpected value instead of treating it as false', () => {
    expect(() => parseHwlResult(hwlResponse('MAYBE'))).toThrow();
  });
  it('THROWS on an empty response', () => {
    expect(() => parseHwlResult({})).toThrow();
    expect(() => parseHwlResult(null)).toThrow();
  });
  it('returns null mmm when absent rather than guessing', () => {
    const r = hwlResponse('Y');
    r.results.mmm2023.features = [];
    expect(parseHwlResult(r).mmm).toBeNull();
  });
});
