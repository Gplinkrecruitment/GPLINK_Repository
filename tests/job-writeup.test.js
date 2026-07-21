const { buildWriteupPrompt, parseWriteupResponse, maskIdentity, scrubWriteup } = require('../lib/job-writeup');

describe('buildWriteupPrompt', () => {
  it('forbids naming the practice, doctors, or street in the prompt', () => {
    const p = buildWriteupPrompt({ details: { percentage_split: '70' }, introText: 'nice area', websiteText: 'skin clinic', suburb: 'Erina', state: 'NSW' });
    expect(p).toMatch(/do not (name|mention|include)[^.]*practice/i);
    expect(p).toMatch(/JSON/);
    expect(p).toContain('Erina');
    expect(p).toContain('skin clinic'); // website text is fed in
  });
  it('omits the website section when no website text is available', () => {
    const p = buildWriteupPrompt({ details: {}, introText: 'x', websiteText: '', suburb: 'Erina', state: 'NSW' });
    expect(p).not.toMatch(/website says|from their website/i);
  });
});

describe('parseWriteupResponse', () => {
  it('parses a well-formed JSON block even with prose around it', () => {
    const raw = 'Here you go:\n{"about":"An established practice on the Central Coast.","highlights":["DPA location","On-site nursing"],"sources":["form","area"]}\nHope that helps';
    expect(parseWriteupResponse(raw)).toMatchObject({ about: 'An established practice on the Central Coast.', highlights: ['DPA location','On-site nursing'], sources: ['form','area'] });
  });
  it('returns null on junk', () => { expect(parseWriteupResponse('no json here')).toBeNull(); expect(parseWriteupResponse('')).toBeNull(); });
  it('coerces a missing highlights/sources to arrays', () => {
    expect(parseWriteupResponse('{"about":"x"}')).toMatchObject({ about: 'x', highlights: [], perks: [], sources: [] });
  });
  it('parses structured perks and drops malformed items', () => {
    const raw = '{"about":"x","perks":[{"label":"Income guarantee","value":"$200/hr for 3 months"},{"label":"Relocation","value":"$25,000"},{"junk":true},{"label":"","value":"y"},{"label":"z","value":""}],"sources":["form"]}';
    const p = parseWriteupResponse(raw);
    expect(p.perks).toEqual([
      { label: 'Income guarantee', value: '$200/hr for 3 months' },
      { label: 'Relocation', value: '$25,000' },
    ]);
  });
  it('defaults perks to [] when absent', () => {
    expect(parseWriteupResponse('{"about":"x"}').perks).toEqual([]);
  });
});

describe('maskIdentity, the safety backstop', () => {
  it('removes the practice name wherever it appears', () => {
    expect(maskIdentity('Erina Medical Centre is a great place; join Erina Medical Centre.', { practiceName: 'Erina Medical Centre' }))
      .not.toMatch(/Erina Medical Centre/);
  });
  it('removes a street address', () => {
    expect(maskIdentity('Located at 60A Erina Valley Rd, come visit.', { address: '60A Erina Valley Rd, Erina NSW 2250' }))
      .not.toMatch(/60A Erina Valley Rd/);
  });
  it('removes doctor names like "Dr Smith"', () => {
    expect(maskIdentity('Led by Dr Jane Smith and Dr Patel.', {})).not.toMatch(/Dr Jane Smith|Dr Patel/);
  });
  it('leaves ordinary text alone', () => {
    expect(maskIdentity('An established practice on the NSW Central Coast.', { practiceName: 'Erina Medical Centre' }))
      .toBe('An established practice on the NSW Central Coast.');
  });
});

describe('scrubWriteup', () => {
  it('scrubs about and every highlight', () => {
    const w = scrubWriteup({ about: 'Erina Medical Centre rocks', highlights: ['Join Erina Medical Centre','DPA location'], sources: ['form'] }, { practiceName: 'Erina Medical Centre' });
    expect(w.about).not.toMatch(/Erina Medical Centre/);
    expect(w.highlights[0]).not.toMatch(/Erina Medical Centre/);
    expect(w.highlights[1]).toBe('DPA location');
  });
  it('never throws on empty input', () => { expect(() => scrubWriteup({ about:'', highlights: [] }, {})).not.toThrow(); });
  it('scrubs the practice name out of perk labels and values', () => {
    const w = scrubWriteup({ about: 'x', highlights: [], perks: [{ label: 'Relocation to Erina Medical Centre', value: 'Erina Medical Centre pays $25,000' }] }, { practiceName: 'Erina Medical Centre' });
    expect(w.perks[0].label).not.toMatch(/Erina Medical Centre/);
    expect(w.perks[0].value).not.toMatch(/Erina Medical Centre/);
    expect(w.perks[0].value).toMatch(/\$25,000/);
  });
});
