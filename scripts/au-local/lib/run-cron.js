#!/usr/bin/env node
'use strict';
/*
 * Calls /api/cron/<name> on the LOCAL app server with the local cron secret.
 * It can only ever call this Mac: the address is built from the local port.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');

function cronNames() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(cfg.REPO_ROOT, 'vercel.json'), 'utf8'));
    return (v.crons || []).map((c) => ({ name: String(c.path || '').replace(/^\/api\/cron\//, ''), schedule: c.schedule }));
  } catch (e) { return []; }
}

(async () => {
  const arg = process.argv[2];
  const names = cronNames();
  if (!arg || arg === '--list' || arg === '-l') {
    console.log('Scheduled jobs defined in vercel.json (run one with: scripts/au-local/run-cron.sh <name>):');
    for (const c of names) console.log('  ' + c.name.padEnd(30) + c.schedule);
    process.exit(arg ? 0 : 1);
  }
  const name = String(arg).replace(/^\/?api\/cron\//, '').replace(/^\/+/, '');
  if (!/^[a-z0-9-]+(\?.*)?$/i.test(name)) { console.error('STOP: "' + arg + '" is not a job name.'); process.exit(1); }
  if (!names.some((c) => c.name === name.split('?')[0])) console.log('note: "' + name.split('?')[0] + '" is not in vercel.json; calling it anyway.');
  const secrets = cfg.loadSecrets();
  const url = 'http://127.0.0.1:' + cfg.PORTS.app + '/api/cron/' + name;
  console.log('Running scheduled job "' + name + '" on the local app...');
  let resp;
  try {
    resp = await fetch(url, { headers: { Authorization: 'Bearer ' + secrets.cronSecret, 'User-Agent': 'vercel-cron/1.0' }, signal: AbortSignal.timeout(300000) });
  } catch (e) {
    console.error('STOP: could not reach the local app (' + e.message + '). Is it running? Start it with scripts/au-local/start.sh');
    process.exit(1);
  }
  const text = await resp.text();
  let shown = text;
  try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* not JSON */ }
  console.log('Answer: HTTP ' + resp.status);
  console.log(shown.length > 6000 ? shown.slice(0, 6000) + '\n...[truncated]' : shown);
  console.log('\nAny message this job tried to send is in the Outbox: ' + cfg.GATEWAY_URL + '/outbox');
  process.exit(resp.ok ? 0 : 2);
})();
