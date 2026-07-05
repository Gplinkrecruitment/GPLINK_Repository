// lib/zoho-archive.js — pure helpers for the Zoho data capture (no I/O).

function firstString(record, keys) {
  for (const k of keys) {
    const v = record && record[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// A candidate counts as hired if a status field reads hired/placed.
function isZohoCandidateHired(record) {
  const status = firstString(record || {}, ['Candidate_Status', 'Status', '$state']).toLowerCase();
  return /\b(hired|placed)\b/.test(status);
}

// Build a re-engagement lead (name/email/phone). Null when no email.
function toCandidateLead(record) {
  const r = record || {};
  const email = firstString(r, ['Email', 'Email_Address', 'Secondary_Email']);
  if (!email) return null;
  let name = firstString(r, ['Full_Name', 'Candidate_Name', 'Name']);
  if (!name) {
    const fn = firstString(r, ['First_Name']);
    const ln = firstString(r, ['Last_Name']);
    name = [fn, ln].filter(Boolean).join(' ');
  }
  const phone = firstString(r, ['Phone', 'Mobile', 'Contact_Number']);
  return { name: name, email: email, phone: phone, zoho_candidate_id: String(r.id || '') };
}

// Normalize any raw Zoho record into a zoho_archive row. Null when no id.
function normalizeArchiveRow(entityType, record, pulledAtIso) {
  const id = record && record.id != null ? String(record.id) : '';
  if (!id) return null;
  return { entity_type: String(entityType), zoho_id: id, payload: record, pulled_at: pulledAtIso };
}

export { isZohoCandidateHired, toCandidateLead, normalizeArchiveRow };
