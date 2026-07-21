import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Practice-supplied website URLs are fetched server-side (AI write-up), so the
// URL sanitizer must reject loopback / private / link-local / cloud-metadata
// hosts. Extracts the pure isBlockedSsrfHostname() from server.js and exercises
// it (no server boot needed, the function has no dependencies).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  // Walk braces from the first '{' to find the matching close.
  const open = SRC.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}

// eslint-disable-next-line no-new-func
const isBlockedSsrfHostname = new Function(extract('isBlockedSsrfHostname') + '\nreturn isBlockedSsrfHostname;')();

describe('SSRF hostname guard', () => {
  const BLOCKED = [
    'localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '10.1.2.3',
    '192.168.0.1', '172.16.5.5', '172.31.255.1', '100.64.0.1',
    'metadata.google.internal', 'foo.internal', 'db.local', '::1',
    'fe80::1', 'fd00::1', '::ffff:127.0.0.1'
  ];
  BLOCKED.forEach((h) => {
    it('blocks ' + h, () => { expect(isBlockedSsrfHostname(h)).toBe(true); });
  });

  const ALLOWED = [
    'example.com', 'www.mypractice.com.au', 'clinic.health', '8.8.8.8',
    '172.32.0.1', '11.0.0.1', 'greenslopesfm.com.au'
  ];
  ALLOWED.forEach((h) => {
    it('allows ' + h, () => { expect(isBlockedSsrfHostname(h)).toBe(false); });
  });
});
