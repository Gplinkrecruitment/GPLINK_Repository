/* ============================================================================
 * ats-job-view-links.js, pure helper that turns an ATS jobs-list card into the
 * two "view this opening" URLs used by the CEO/consultant Jobs board:
 *   • appUrl     → the in-app (logged-in) job page  /pages/job.html?id=<publicId>
 *   • websiteUrl → the public marketing job page     /jobs/view?id=<publicId>
 *
 * The public id is the same "<provider>:<provider_role_id>" string the server's
 * makeCareerRoleId() emits and parseCareerRolePublicId() reads. The server now
 * ships it precomputed as `public_id` on each jobs-list card; we still derive it
 * from provider/provider_role_id as a fallback.
 *
 * Loaded as a classic <script> (exposes window.buildJobViewLinks) and importable
 * from Node/vitest via module.exports, no DOM or window dependency.
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.buildJobViewLinks = api.buildJobViewLinks;
    root.atsMakePublicId = api.makePublicId;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function makePublicId(job) {
    if (!job) return '';
    if (job.public_id) return String(job.public_id);
    var rid = job.provider_role_id ? String(job.provider_role_id) : '';
    if (!rid) return '';
    var provider = job.provider ? String(job.provider) : 'zoho_recruit';
    return provider + ':' + rid;
  }

  function buildJobViewLinks(job) {
    var publicId = makePublicId(job);
    if (!publicId) return { publicId: '', appUrl: '', websiteUrl: '' };
    var enc = encodeURIComponent(publicId);
    return {
      publicId: publicId,
      appUrl: '/pages/job.html?id=' + enc,
      websiteUrl: '/jobs/view?id=' + enc
    };
  }

  return { buildJobViewLinks: buildJobViewLinks, makePublicId: makePublicId };
});
