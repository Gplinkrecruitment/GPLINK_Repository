#!/usr/bin/env node
'use strict';

/**
 * Upload a month of social creatives into the review queue.
 *
 * The images themselves are produced outside this repo (see
 * docs/social-campaign-pipeline.md) because generation needs the Higgsfield
 * connector, which is interactively authenticated and unavailable to a cron.
 * This script is the bridge: it takes a folder of JPEGs plus a manifest and
 * POSTs them to /api/admin/social/ingest, which is where the automated half of
 * the pipeline begins.
 *
 * Usage:
 *   SOCIAL_INGEST_TOKEN=... node scripts/social-ingest.js \
 *     --dir ~/Downloads/gplink-social-2026-09 \
 *     --manifest posts.json \
 *     --month 2026-09 \
 *     [--base https://www.mygplink.com.au] \
 *     [--ready]      # mark the month finished, which puts it in front of the CEO
 *     [--dry-run]
 *
 * The manifest is an array of:
 *   { slot, file, caption, alt_text?, pillar?, source_ref?, targets? }
 * `file` is relative to --dir.
 *
 * Re-running is safe: a slot that already exists is replaced, not duplicated,
 * and replacing a creative resets it to 'needs review' so an edit can never
 * sneak past the approval gate.
 */

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

async function main() {
  const dir = String(arg('dir', '') || '');
  const manifestName = String(arg('manifest', 'posts.json'));
  const month = String(arg('month', '') || '');
  const base = String(arg('base', process.env.SOCIAL_BASE_URL || 'https://www.mygplink.com.au')).replace(/\/+$/, '');
  const ready = arg('ready', false) === true;
  const dryRun = arg('dry-run', false) === true;
  const token = String(process.env.SOCIAL_INGEST_TOKEN || '').trim();
  const batchSize = Number(arg('batch', 10)) || 10;

  if (!dir) fail('--dir is required.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('--month must be YYYY-MM.');
  if (!token && !dryRun) fail('SOCIAL_INGEST_TOKEN is not set.');

  const manifestPath = path.isAbsolute(manifestName) ? manifestName : path.join(dir, manifestName);
  if (!fs.existsSync(manifestPath)) fail('No manifest at ' + manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest)) fail('The manifest must be an array.');

  const posts = [];
  manifest.forEach(function (item, i) {
    const slot = Number(item.slot) || (i + 1);
    const file = path.isAbsolute(item.file) ? item.file : path.join(dir, item.file);
    if (!fs.existsSync(file)) fail('Slot ' + slot + ': no such image ' + file);
    const bytes = fs.readFileSync(file);
    const dims = jpegSize(bytes) || {};
    posts.push({
      slot: slot,
      caption: String(item.caption || ''),
      alt_text: item.alt_text || null,
      pillar: item.pillar || null,
      source_ref: item.source_ref || null,
      targets: item.targets || { facebook: true, instagram: true },
      image_width: item.image_width || dims.width || null,
      image_height: item.image_height || dims.height || null,
      image_data_url: 'data:image/jpeg;base64,' + bytes.toString('base64')
    });
  });

  console.log('Month ' + month + ': ' + posts.length + ' creatives from ' + dir);
  const oversize = posts.filter(function (p) { return p.image_data_url.length > 4 * 1024 * 1024; });
  if (oversize.length) {
    fail(oversize.length + ' image(s) exceed the ~4.5MB serverless body limit once base64-encoded. ' +
      'Re-export them smaller (a 1080x1350 JPEG at quality 85 is well under 500KB).');
  }
  if (dryRun) {
    console.log('Dry run: nothing sent. First caption:\n' + posts[0].caption.slice(0, 200));
    return;
  }

  // Batched: 60 base64 JPEGs in one body would blow the request limit.
  let created = 0, replaced = 0, failed = 0;
  for (let i = 0; i < posts.length; i += batchSize) {
    const chunk = posts.slice(i, i + batchSize);
    const isLast = (i + batchSize) >= posts.length;
    const res = await fetch(base + '/api/admin/social/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ month: month, posts: chunk, ready: ready && isLast })
    });
    const data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || !data.ok) {
      console.error('  batch ' + (i / batchSize + 1) + ' failed:', (data && (data.message || data.problems)) || res.status);
      failed += chunk.length;
      continue;
    }
    created += data.created || 0;
    replaced += data.replaced || 0;
    console.log('  batch ' + (i / batchSize + 1) + ': +' + (data.created || 0) + ' new, ' + (data.replaced || 0) + ' replaced (total ' + data.total + ')');
  }

  console.log('\n' + created + ' created, ' + replaced + ' replaced, ' + failed + ' failed.');
  if (ready) console.log('Marked ready — the CEO dashboard Social tab now shows the month for review.');
  else console.log('Not marked ready. Re-run with --ready when the month is complete.');
  if (failed) process.exit(1);
}

// Minimal JPEG dimension reader, so the manifest does not have to repeat what
// the file already knows. Instagram rejects the wrong aspect ratio, and the
// server validates it, so getting this right here saves a round trip.
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let off = 2;
  while (off < buf.length) {
    if (buf[off] !== 0xFF) { off++; continue; }
    const marker = buf[off + 1];
    // SOF0..SOF15, excluding the non-frame markers in that range.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

main().catch(function (err) {
  console.error('✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
