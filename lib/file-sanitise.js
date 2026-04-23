'use strict';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// Magic byte signatures for each supported MIME type.
// 'offset' is the byte position in the file where the signature starts.
const MAGIC_BYTES = {
  'application/pdf': { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 }, // %PDF
  'image/jpeg':      { bytes: [0xFF, 0xD8, 0xFF],        offset: 0 },
  'image/png':       { bytes: [0x89, 0x50, 0x4E, 0x47],  offset: 0 }, // \x89PNG
  'image/webp':      { bytes: [0x52, 0x49, 0x46, 0x46],  offset: 0 }, // RIFF
  'application/msword':
                     { bytes: [0xD0, 0xCF, 0x11, 0xE0],  offset: 0 }, // OLE2
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                     { bytes: [0x50, 0x4B, 0x03, 0x04],  offset: 0 }, // PK (ZIP)
};

// PDF embedded-action patterns that indicate potentially malicious content.
const PDF_DANGEROUS_PATTERNS = [
  /\/JavaScript\b/i,
  /\/Launch\b/i,
  /\/OpenAction\b/i,
  /\/AA\s*<</i,
];

/**
 * Sanitise a filename for safe storage.
 *  - Removes path-traversal sequences (../ and ..\)
 *  - Strips null bytes and ASCII control characters (0x00–0x1F, 0x7F)
 *  - Replaces shell/filesystem-unsafe characters with underscores
 *  - Truncates to 255 characters while preserving the extension
 *  - Returns 'document' when the result would be empty
 *
 * @param {string} name
 * @returns {string}
 */
function sanitiseFileName(name) {
  if (!name || typeof name !== 'string') return 'document';

  let s = name;

  // Strip path traversal
  s = s.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');

  // Strip null bytes and control characters (0x00–0x1F, 0x7F)
  s = s.replace(/[\x00-\x1F\x7F]/g, '');

  // Replace characters unsafe in filenames / on common filesystems
  s = s.replace(/[/\\:*?"<>|]/g, '_');

  s = s.trim();

  if (!s) return 'document';

  // Enforce 255-character limit, preserving extension
  if (s.length > 255) {
    const dotIdx = s.lastIndexOf('.');
    const ext = (dotIdx > 0 && dotIdx > s.length - 10) ? s.slice(dotIdx) : '';
    s = s.slice(0, 255 - ext.length) + ext;
  }

  return s;
}

/**
 * Check that the declared MIME type is on the allow-list.
 *
 * @param {string} mimeType
 * @returns {boolean}
 */
function validateMimeType(mimeType) {
  return ALLOWED_MIME_TYPES.has(String(mimeType ?? '').trim().toLowerCase());
}

/**
 * Verify the file buffer starts with the expected magic bytes for the
 * declared MIME type.  HEIC is skipped because its magic bytes appear at
 * a variable offset that requires a full ISO-BMFF parser.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {boolean}
 */
function validateMagicBytes(buffer, mimeType) {
  if (!buffer || buffer.length < 4) return false;

  const mime = String(mimeType ?? '').trim().toLowerCase();

  // HEIC magic bytes are inside an ISO Base Media File Format box at a
  // variable offset — skip byte-level validation for this type.
  if (mime === 'image/heic') return true;

  const spec = MAGIC_BYTES[mime];
  if (!spec) return true; // No spec for this type; pass through.

  for (let i = 0; i < spec.bytes.length; i++) {
    if (buffer[spec.offset + i] !== spec.bytes[i]) return false;
  }
  return true;
}

/**
 * Scan a PDF buffer for embedded action types that could execute arbitrary
 * code or make network requests when the document is opened.
 *
 * @param {Buffer} buffer
 * @returns {{ safe: boolean, reason?: string }}
 */
function validatePdfSafety(buffer) {
  if (!buffer || buffer.length === 0) {
    return { safe: false, reason: 'Empty file.' };
  }

  // Decode as latin1 so every byte value maps 1-to-1 to a character;
  // this avoids UTF-8 decoding issues with binary PDF streams.
  const content = buffer.toString('latin1');

  for (const pattern of PDF_DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      return {
        safe: false,
        reason: 'PDF contains potentially dangerous embedded actions.',
      };
    }
  }

  return { safe: true };
}

/**
 * Full file-upload validation pipeline.
 *  1. Size limit (10 MB)
 *  2. MIME type allow-list
 *  3. Magic byte verification
 *  4. PDF safety scan (PDFs only)
 *
 * @param {Buffer}  buffer
 * @param {string}  mimeType   Declared MIME type from the upload
 * @param {string}  fileName   Original filename from the upload
 * @returns {{ valid: boolean, errors: string[], sanitisedFileName: string, mimeType: string }}
 */
function validateFileUpload(buffer, mimeType, fileName) {
  const errors = [];
  const cleanMime = String(mimeType ?? '').trim().toLowerCase();
  const sanitisedFileName = sanitiseFileName(fileName);

  if (!buffer || buffer.length === 0) {
    errors.push('File is empty.');
  } else if (buffer.length > MAX_FILE_SIZE_BYTES) {
    errors.push('File exceeds 10MB limit.');
  }

  if (!validateMimeType(cleanMime)) {
    errors.push('File type not allowed. Accepted: PDF, JPEG, PNG, WebP, HEIC, DOC, DOCX.');
  }

  if (buffer && buffer.length >= 4 && !validateMagicBytes(buffer, cleanMime)) {
    errors.push('File content does not match its declared type.');
  }

  if (cleanMime === 'application/pdf' && buffer && buffer.length > 0) {
    const pdfCheck = validatePdfSafety(buffer);
    if (!pdfCheck.safe) errors.push(pdfCheck.reason);
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitisedFileName,
    mimeType: cleanMime,
  };
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPES,
  sanitiseFileName,
  validateMimeType,
  validateMagicBytes,
  validatePdfSafety,
  validateFileUpload,
};
