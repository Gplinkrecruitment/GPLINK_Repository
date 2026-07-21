// Task 8, the redesigned practice intake form. This repo tests HTML pages
// by reading the file and asserting on its contents (see
// tests/practice-status-page.test.js for the live-server pattern used
// elsewhere; this file deliberately stays a pure static-content check so it
// runs fast and never needs a live server or a real Google/DPA call).
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'practice-intake.html'), 'utf8');

describe('practice intake form - the redesign', () => {
  it('asks for the address once, with autocomplete', () => {
    expect(html).toMatch(/id="addr"/);
    expect(html).toMatch(/places\.googleapis\.com|placesService|autocomplete/i);
  });
  it('no longer asks for suburb, nearest city or general location as questions', () => {
    // They are derived from the address and shown back for confirmation.
    expect(html).not.toMatch(/<input[^>]+id="suburb"/);
    expect(html).not.toMatch(/<input[^>]+id="nearest_city"/);
    expect(html).not.toMatch(/<input[^>]+id="general_location"/);
  });
  it('offers a manual fallback so a missed lookup can never block a submit', () => {
    expect(html).toMatch(/id="manual"/);
  });
  it('asks for urgency with the three agreed options', () => {
    expect(html).toMatch(/asap/); expect(html).toMatch(/3_6m/); expect(html).toMatch(/12m/);
  });
  it('asks full-time or part-time and never asks days and hours', () => {
    expect(html).toMatch(/full_time/); expect(html).toMatch(/part_time/);
    expect(html).not.toMatch(/days\s*&amp;?\s*hours/i);
    expect(html).not.toMatch(/sessions per week/i);
  });
  it('does not ask for a role title', () => {
    expect(html).not.toMatch(/<input[^>]+id="role_title"/);
  });
  it('asks for the practice website', () => {
    expect(html).toMatch(/id="website"/);
  });
  it('gives the incentives box a worked example including an income guarantee', () => {
    expect(html).toMatch(/income guarantee/i);
    expect(html).toMatch(/relocation/i);
  });
  it('accepts an ABN or an ACN', () => {
    expect(html).toMatch(/ACN/);
  });
  it('makes the practice confirm DPA rather than accepting our suggestion', () => {
    expect(html).toMatch(/dpaYes/); expect(html).toMatch(/dpaNo/);
    expect(html).toMatch(/confirm/i);
  });
  it('embeds the agreement so nobody signs a document they have not seen', () => {
    expect(html).toMatch(/gp-link-practice-agreement-2026\.pdf/);
  });
  it('gates the submit on all 8 fields', () => {
    expect(html).toMatch(/of 8 completed/);
    expect(html).toMatch(/id="submit"[^>]*disabled/);
  });
  it('persists a draft so a reload does not lose the practice\'s work', () => {
    expect(html).toMatch(/gplink_intake_draft_v3/);
  });
  it('stays out of search results', () => {
    expect(html).toMatch(/noindex/);
  });
});

describe('DPA is named correctly', () => {
  // "District of Priority Area" is not a thing. The Department of Health term is
  // "Distribution Priority Area" -- and this label is read by practices deciding
  // an answer that governs which overseas-trained GPs may work for them.
  it('calls it a Distribution Priority Area, not a District of Priority Area', () => {
    expect(html).toMatch(/Distribution Priority Area \(DPA\)/);
    expect(html).not.toMatch(/District of Priority/);
  });
});
