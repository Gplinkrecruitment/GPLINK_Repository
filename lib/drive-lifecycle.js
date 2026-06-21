// lib/drive-lifecycle.js
'use strict';

const LIFECYCLE_FOLDER_NAMES = Object.freeze({
  users: 'Users',
  candidates: 'Candidates',
  archived: 'Archived',
});

// Which lifecycle folder a GP's personal folder belongs in.
function stageForCase({ accountStatus, placementSecured } = {}) {
  if (String(accountStatus || '').toLowerCase() === 'archived') return 'archived';
  if (placementSecured) return 'candidates';
  return 'users';
}

// AI-accepted-on-upload and manual approval both set user_documents.status='approved'.
function isAcceptedStatus(status) {
  return String(status || '').toLowerCase() === 'approved';
}

module.exports = { LIFECYCLE_FOLDER_NAMES, stageForCase, isAcceptedStatus };
