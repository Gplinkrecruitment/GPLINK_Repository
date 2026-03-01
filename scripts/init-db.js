const fs = require('fs');
const path = require('path');

const dbFilePath = process.env.DB_FILE_PATH || path.join(process.cwd(), 'data', 'app-db.json');
const dbDir = path.dirname(dbFilePath);

function createEmptyState() {
  return {
    version: 1,
    otpChallenges: {},
    rateLimits: {},
    sessions: {},
    passwordResetTokens: {},
    users: {},
    userProfiles: {},
    userState: {}
  };
}

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

if (!fs.existsSync(dbFilePath)) {
  fs.writeFileSync(dbFilePath, JSON.stringify(createEmptyState(), null, 2));
  console.log(`Created DB file at ${dbFilePath}`);
  process.exit(0);
}

try {
  const parsed = JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
  const merged = { ...createEmptyState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  fs.writeFileSync(dbFilePath, JSON.stringify(merged, null, 2));
  console.log(`DB file already exists and is valid: ${dbFilePath}`);
} catch (err) {
  const backupPath = `${dbFilePath}.corrupt.${Date.now()}.bak`;
  fs.copyFileSync(dbFilePath, backupPath);
  fs.writeFileSync(dbFilePath, JSON.stringify(createEmptyState(), null, 2));
  console.log(`Recovered corrupt DB. Backup written to ${backupPath}`);
}
