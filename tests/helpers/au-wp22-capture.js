'use strict';

/**
 * WP-22: writes tests/fixtures/au-wp22-public-parity.snapshot.json.
 *
 * It was run ONCE, on commit c71f3e97, before WP-22 changed any code. Do not
 * run it again to make a failing parity test pass: the snapshot is the record
 * of what the public job board answered before this package existed.
 *
 *   node tests/helpers/au-wp22-capture.js
 */

process.env.AGENT_SKIP_DOTENV = 'true';
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'x'.repeat(40);
process.env.REQUIRE_SUPABASE_DB = 'false';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_PUBLISHABLE_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.DB_FILE_PATH = '/tmp/gplink-wp22-capture-db.json';
process.env.OPENAI_API_KEY = '';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require(path.join(root, 'server.js')).__testUtils;
const { capturePublicParity } = require('./au-wp22-parity.js');

process.env.AU_PATHWAY_ENABLED = 'false';
const off = capturePublicParity(t);
process.env.AU_PATHWAY_ENABLED = 'true';
const on = capturePublicParity(t);
console.log('switch on equals switch off at capture time:', JSON.stringify(on) === JSON.stringify(off));
fs.writeFileSync(
  path.join(root, 'tests', 'fixtures', 'au-wp22-public-parity.snapshot.json'),
  JSON.stringify({ capturedFrom: process.argv[2] || 'unknown', snapshot: off }, null, 1) + '\n'
);
console.log('queries:', Object.keys(off.jobs).length);
console.log(JSON.stringify(off.jobs['(none)'].jobs[0]).slice(0, 1200));
process.exit(0);
