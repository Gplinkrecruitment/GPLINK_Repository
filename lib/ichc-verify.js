'use strict';
const crypto = require('crypto');

const EXAMPLE_ICHC_REFERENCES = ['FIT1234567', 'FIT7623801'];
const EXAMPLE_ICHC_FILE_SHA256 = [
  'c176ad9cc310f83267b6c0f5ca24f4525aebece7ef328be19f3771683d9f81e2', // redacted sample
  '3dea2e94a2179d954a1b58750014e49094d3423f207a6c913d119bead6751cc8', // original (real PII)
];

function normalizeIchcReference(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/FIT[\s-]?(\d{7})(?!\d)/i);
  return m ? 'FIT' + m[1] : null;
}
function isValidIchcReference(ref) {
  return typeof ref === 'string' && /^FIT\d{7}$/.test(ref);
}
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function isExampleIchcReference(ref) {
  const norm = normalizeIchcReference(ref) || (typeof ref === 'string' ? ref.toUpperCase() : '');
  return EXAMPLE_ICHC_REFERENCES.includes(norm);
}
function isExampleIchcFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  return EXAMPLE_ICHC_FILE_SHA256.includes(sha256Hex(buf));
}

module.exports = {
  EXAMPLE_ICHC_REFERENCES, EXAMPLE_ICHC_FILE_SHA256,
  normalizeIchcReference, isValidIchcReference, sha256Hex,
  isExampleIchcReference, isExampleIchcFile,
};
