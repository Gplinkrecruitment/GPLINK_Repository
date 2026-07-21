/*
 * document-prep.js, shared "prepare your documents" brain.
 *
 * Standalone, page-independent module so the global Scan button (in the app
 * shell nav) can build the GP's document checklist and persist a scan result
 * the same way pages/my-documents.html does, without that page being loaded.
 *
 * It reads/writes the SAME state as my-documents.html:
 *   - localStorage key `gp_documents_prep` (state-sync tracked → Supabase)
 *   - server endpoint  PUT /api/prepared-documents
 * The stored value format matches my-documents.html (plain JSON of the
 * serialized state). We also reset the page's batch-meta key so a later
 * flushBatchedSave there can't clobber our write with a stale value.
 *
 * ⚠ PREPARED_DOCS below MUST stay in sync with the per-country prepared lists
 *   in lib/document-requirements.js (the server-side source of truth served by
 *   GET /api/gp/document-requirements; pages/my-documents.html renders it and
 *   keeps a matching FALLBACK_COUNTRY_DOCS). tests/document-prep.test.js and
 *   tests/doc-requirements.test.js guard against drift.
 */
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var DOC_KEY = "gp_documents_prep";
  var COUNTRY_KEY = "gp_selected_country";
  var BATCH_META_SUFFIX = "__save_batch_meta";

  // Statuses that count as "this document is prepared / no longer outstanding".
  var DONE_STATUSES = ["uploaded", "under_review", "approved", "accepted", "certified"];

  // The "you provide" documents per country. Verbatim from my-documents.html.
  var PREPARED_DOCS = {
    uk: [
      { key: "primary_medical_degree", title: "Certified copy of Primary Medical Degree (MBBS/MBChB)", help: { title: "Primary Medical Degree", steps: ["Upload a certified copy of your primary medical degree"], certNote: true } },
      { key: "mrcgp_certified", title: "Certified copy of MRCGP", help: { title: "MRCGP", steps: ["Upload a certified copy of your MRCGP certificate"], certNote: true } },
      { key: "cct_certified", title: "Certified copy of CCT (General Practice) issued by the General Medical Council or PMETB", help: { title: "CCT", steps: ["Upload a certified copy of your CCT certificate issued by the GMC or PMETB"], certNote: true } },
      { key: "cv_signed_dated", title: "CV (Signed and dated)", help: { title: "CV", steps: ["Upload your signed and dated CV"] } }
    ],
    ie: [
      { key: "primary_medical_degree", title: "Certified copy of Primary Medical Degree", help: { title: "Primary Medical Degree", steps: ["Upload a certified copy of your primary medical degree"], certNote: true } },
      { key: "micgp_certified", title: "Certified copy of MICGP", help: { title: "MICGP", steps: ["Upload a certified copy of your MICGP certificate", "If you do not have a copy, request a re-issue from ICGP Membership Services"], certNote: true } },
      { key: "cscst_certified", title: "Certified copy of CSCST", help: { title: "CSCST", steps: ["Upload a certified copy of your CSCST", "If needed, request a re-issue from ICGP Membership Services"], certNote: true } },
      { key: "icgp_confirmation_letter", title: "Certified copy of ICGP Confirmation Letter", help: { title: "ICGP Confirmation Letter", steps: ["Contact ICGP Membership Services", "Request a confirmation / verification letter confirming your qualification was awarded under the ICGP curriculum after completion of the approved GP training pathway", "If needed, request verification of training through ICGP"], certNote: true, reminder: "This is the key supporting letter for Irish GPs." } },
      { key: "cv_signed_dated", title: "CV (Signed and dated)", help: { title: "CV", steps: ["Upload your signed and dated CV"] } }
    ],
    nz: [
      { key: "primary_medical_degree", title: "Certified copy of Primary Medical Degree", help: { title: "Primary Medical Degree", steps: ["Upload a certified copy of your primary medical degree"], certNote: true } },
      { key: "frnzcgp_certified", title: "Certified copy of FRNZCGP", help: { title: "FRNZCGP", steps: ["Upload a certified copy of your FRNZCGP certificate", "If needed, contact RNZCGP for replacement or confirmation"], certNote: true } },
      { key: "rnzcgp_confirmation_letter", title: "Certified copy of RNZCGP Confirmation Letter", help: { title: "RNZCGP Confirmation Letter", steps: ["Contact RNZCGP", "Request a confirmation letter stating that your fellowship was awarded under the RNZCGP curriculum following satisfactory completion of GPEP"], certNote: true } },
      { key: "cv_signed_dated", title: "CV (Signed and dated)", help: { title: "CV", steps: ["Upload your signed and dated CV"] } }
    ]
  };

  /* ── country resolution (mirrors my-documents.html getCountry) ── */
  function rawCountry() {
    try { return localStorage.getItem(COUNTRY_KEY) || ""; } catch (e) { return ""; }
  }
  function normalizeCountry(raw) {
    var val = raw;
    try { val = JSON.parse(raw); } catch (e) { /* use raw */ }
    if (typeof val !== "string") return "uk";
    var lower = val.toLowerCase().trim();
    if (lower === "uk" || lower === "gb" || lower === "united kingdom") return "uk";
    if (lower === "ie" || lower === "ireland") return "ie";
    if (lower === "nz" || lower === "new zealand") return "nz";
    return "uk";
  }
  function getCountry() {
    var raw = rawCountry();
    if (!raw) return "uk";
    return normalizeCountry(raw);
  }
  function hasCountry() { return !!rawCountry(); }
  function setCountry(name) {
    try { localStorage.setItem(COUNTRY_KEY, JSON.stringify(name)); } catch (e) {}
  }

  function getPreparedDocs(country) { return PREPARED_DOCS[country] || PREPARED_DOCS.uk; }
  function getScannableDocs(country) {
    return getPreparedDocs(country).filter(function (d) { return d.help && d.help.certNote === true; });
  }

  /* ── state read (format-compatible with my-documents.html) ── */
  function parseStorage(key) {
    var raw;
    try { raw = localStorage.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function loadState(country) {
    var parsed = parseStorage(DOC_KEY);
    if (!parsed || typeof parsed !== "object" || parsed.country !== country || !parsed.docs) {
      var docs = {};
      getPreparedDocs(country).forEach(function (doc) {
        docs[doc.key] = { uploaded: false, fileName: "", status: "pending" };
      });
      return { country: country, docs: docs, certFailCounts: {}, updatedAt: "" };
    }
    return parsed;
  }

  function isSatisfied(docState) {
    if (!docState || typeof docState !== "object") return false;
    if (docState.uploaded === true) return true;
    return DONE_STATUSES.indexOf(docState.status) !== -1;
  }

  /* ── derived views the router uses ── */
  function getOutstandingScannable(country) {
    var state = loadState(country);
    var docs = state.docs || {};
    var outstanding = getScannableDocs(country).filter(function (doc) {
      return !isSatisfied(docs[doc.key]);
    });
    // certified-copies-first (stable). All scannable docs are certified today,
    // but keep the rule so it holds if a non-cert scannable is ever added.
    var cert = [], plain = [];
    outstanding.forEach(function (doc) {
      (doc.help && doc.help.certNote ? cert : plain).push(doc);
    });
    return cert.concat(plain);
  }

  function getProgress(country) {
    var state = loadState(country);
    var docs = state.docs || {};
    var defs = getScannableDocs(country);
    var done = 0;
    defs.forEach(function (doc) { if (isSatisfied(docs[doc.key])) done++; });
    return { prepared: done, total: defs.length };
  }

  /* ── state write (mirrors normalizeStoredDoc/applyStoredFile/serialize) ── */
  function normalizeStoredDoc(doc) {
    var next = doc && typeof doc === "object" ? Object.assign({}, doc) : {};
    if (typeof next.uploaded !== "boolean") next.uploaded = false;
    if (typeof next.fileName !== "string") next.fileName = "";
    if (typeof next.mimeType !== "string") next.mimeType = "";
    if (!isFinite(next.fileSize)) next.fileSize = 0;
    if (typeof next.downloadUrl !== "string") next.downloadUrl = "";
    if (typeof next.storagePath !== "string") next.storagePath = "";
    if (typeof next.storageBucket !== "string") next.storageBucket = "";
    return next;
  }
  function applyStoredFile(docState, payload) {
    var next = normalizeStoredDoc(docState);
    payload = payload || {};
    if (typeof payload.fileName === "string") next.fileName = payload.fileName;
    if (typeof payload.mimeType === "string") next.mimeType = payload.mimeType;
    if (isFinite(payload.fileSize)) next.fileSize = payload.fileSize;
    if (typeof payload.downloadUrl === "string") next.downloadUrl = payload.downloadUrl;
    if (typeof payload.storagePath === "string") next.storagePath = payload.storagePath;
    if (typeof payload.storageBucket === "string") next.storageBucket = payload.storageBucket;
    return next;
  }
  function serialize(state) {
    var snapshot = state && typeof state === "object" ? Object.assign({}, state, { docs: {} }) : { docs: {} };
    var docs = state && state.docs && typeof state.docs === "object" ? state.docs : {};
    Object.keys(docs).forEach(function (key) {
      var current = docs[key] && typeof docs[key] === "object" ? Object.assign({}, docs[key]) : docs[key];
      if (current && typeof current === "object") {
        delete current.downloadUrl; delete current.storagePath; delete current.storageBucket;
      }
      snapshot.docs[key] = current;
    });
    return snapshot;
  }

  function writeState(state) {
    state.updatedAt = new Date().toISOString();
    var value = JSON.stringify(serialize(state));
    try {
      localStorage.setItem(DOC_KEY, value);
      // keep my-documents.html's batch meta consistent so a later flush is a no-op
      localStorage.setItem(DOC_KEY + BATCH_META_SUFFIX, JSON.stringify({ pending: 0, lastValue: value }));
    } catch (e) {}
    if (window.gpLinkStateSync && typeof window.gpLinkStateSync.push === "function") {
      try { window.gpLinkStateSync.push().catch(function () {}); } catch (e) {}
    }
  }

  /* ── server persist (mirrors savePreparedDocumentFile) ── */
  function savePreparedDocumentFile(country, key, payload) {
    return fetch("/api/prepared-documents", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: country,
        key: key,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        fileSize: payload.fileSize,
        fileDataUrl: payload.fileDataUrl,
        forceReview: !!payload.forceReview,
        reviewReason: payload.reviewReason || ""
      })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data.ok || !data.document) throw new Error(data.message || "prepared_document_save_failed");
        return data.document;
      });
    });
  }

  /*
   * Persist a successfully-certified scan: server file + local state + sync.
   * Mirrors the certified branch of my-documents.html's data-cert-scan handler.
   */
  function markPreparedCertified(country, key, storedFile, verification) {
    var v = verification || {};
    return savePreparedDocumentFile(country, key, storedFile).then(function (savedFile) {
      var state = loadState(country);
      if (!state.docs) state.docs = {};
      state.docs[key] = applyStoredFile({
        uploaded: true,
        fileName: storedFile.fileName,
        status: "certified",
        certificationStatus: "certified",
        certifierName: v.certifierName || null,
        certifierOccupation: v.certifierOccupation || null,
        certifierDate: v.certifierDate || null,
        signaturePresent: !!v.signaturePresent,
        stampPresent: !!v.stampPresent,
        certificationIssues: [],
        certificationCheckedAt: new Date().toISOString(),
        aiVerified: true,
        aiVerifiedAt: new Date().toISOString()
      }, savedFile);
      if (state.certFailCounts && key in state.certFailCounts) delete state.certFailCounts[key];
      writeState(state);
      return savedFile;
    });
  }

  window.gpDocPrep = {
    DOC_KEY: DOC_KEY,
    PREPARED_DOCS: PREPARED_DOCS,
    getCountry: getCountry,
    hasCountry: hasCountry,
    setCountry: setCountry,
    getPreparedDocs: getPreparedDocs,
    getScannableDocs: getScannableDocs,
    loadState: loadState,
    isSatisfied: isSatisfied,
    getOutstandingScannable: getOutstandingScannable,
    getProgress: getProgress,
    savePreparedDocumentFile: savePreparedDocumentFile,
    markPreparedCertified: markPreparedCertified
  };
})();
