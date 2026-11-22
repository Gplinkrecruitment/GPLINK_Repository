'use strict';

/**
 * WP-22: everything the public job board, the practice map and the job page's
 * server-rendered head answer for the fixture roles, as one plain object.
 *
 * tests/fixtures/au-wp22-public-parity.snapshot.json was captured with this
 * function from the commit BEFORE WP-22 changed any code (c71f3e97). The
 * parity test runs it again with the switch off and compares every value.
 * A normal test run never rewrites the snapshot.
 */

const crypto = require('crypto');
const { publicRows, PARITY_QUERIES } = require('./au-wp22-fixtures.js');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// A fixed head, so the capture does not depend on the page file.
const HEAD_HTML = '<!doctype html><html><head>\n<title>GP Job Details | GP Link</title>\n'
  + '<link rel="canonical" href="https://www.mygplink.com.au/jobs/view">\n'
  + '<meta property="og:title" content="GP Job Details | GP Link">\n'
  + '<meta property="og:description" content="x">\n'
  + '<meta property="og:url" content="https://www.mygplink.com.au/jobs/view">\n</head><body></body></html>';

function capturePublicParity(t) {
  const rows = publicRows();
  const out = { jobs: {}, map: {}, seo: {} };
  PARITY_QUERIES.forEach(function (qs) {
    out.jobs[qs || '(none)'] = t.buildPublicJobsResponse(publicRows(), new URLSearchParams(qs));
  });
  const jobs = rows.map(t.mapCareerRoleRowToPublicJob).map(t.sanitizePublicJob);
  const practices = jobs.filter(function (j) { return j && j.suburb; }).map(function (j, i) {
    return t.shapeMapPractice(j, j.location_state, { lat: -33.8 - i, lng: 151 + i });
  });
  out.map.practices = practices;
  PARITY_QUERIES.forEach(function (qs) {
    const p = new URLSearchParams(qs);
    out.map[qs || '(none)'] = {
      hasFilters: t.practiceMapHasFilters(p),
      ids: t.filterPracticeMapPractices(practices, p).map(function (x) { return x.id; })
    };
  });
  jobs.forEach(function (job) {
    const html = t.injectJobSeoIntoHtml(HEAD_HTML, job);
    out.seo[job.id] = { jsonLd: t.buildJobPostingJsonLd(job), html: html, sha: sha(html) };
  });
  return JSON.parse(JSON.stringify(out));
}

module.exports = { capturePublicParity, HEAD_HTML };
