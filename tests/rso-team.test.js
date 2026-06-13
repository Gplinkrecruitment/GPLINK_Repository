import { describe, it, expect } from 'vitest';
import { mergeRsoRoster } from '../server.js';

var SEED = [
  { name: 'Khaleed Mahmoud', email: 'khaleedmahmoud1211@gmail.com', phone: '+61406281243', user_id: '2f94f870-7ab2-4f71-98ad-bf3756ed88db' },
  { name: 'Hazel', email: 'hazel@mygplink.com.au', phone: '', user_id: '7bed5eb8-f03d-40d6-b090-eb006cd02be7' }
];

describe('mergeRsoRoster', function () {
  it('falls back to the seed array when there are no DB rows', function () {
    var out = mergeRsoRoster([], SEED);
    expect(out.length).toBe(2);
    expect(out[0].user_id).toBe('2f94f870-7ab2-4f71-98ad-bf3756ed88db');
    expect(out[0].active).toBe(true);
    expect(out[1].phone).toBe('');
  });

  it('returns DB rows (active only) when present, normalized', function () {
    var rows = [
      { user_id: 'u1', name: 'New RSO', email: 'new@x.com', phone: '+1', active: true },
      { user_id: 'u2', name: 'Retired RSO', email: 'old@x.com', phone: '', active: false }
    ];
    var out = mergeRsoRoster(rows, SEED);
    expect(out.length).toBe(1);
    expect(out[0].user_id).toBe('u1');
    expect(out[0].email).toBe('new@x.com');
  });

  it('includes inactive rows when includeInactive is set', function () {
    var rows = [
      { user_id: 'u1', name: 'A', email: 'a@x.com', phone: '', active: true },
      { user_id: 'u2', name: 'B', email: 'b@x.com', phone: '', active: false }
    ];
    var out = mergeRsoRoster(rows, SEED, { includeInactive: true });
    expect(out.length).toBe(2);
  });

  it('defaults missing active to true and missing phone to empty string', function () {
    var out = mergeRsoRoster([{ user_id: 'u1', name: 'A', email: 'a@x.com' }], SEED);
    expect(out[0].active).toBe(true);
    expect(out[0].phone).toBe('');
  });
});
