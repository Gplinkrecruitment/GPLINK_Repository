import { describe, it, expect } from 'vitest';
import social from '../lib/social-campaign.js';

// The schedule maths is the part of this feature most likely to be wrong in a
// way nobody notices for a month, so it carries the weight of these tests.
// Melbourne is the interesting case: it is UTC+10 in winter and UTC+11 over
// summer, and the changeover falls inside the campaign months.

describe('month keys', () => {
  it('formats and rolls over December correctly', () => {
    expect(social.monthKey(new Date('2026-08-15T00:00:00Z'))).toBe('2026-08');
    expect(social.nextMonthKey('2026-12')).toBe('2027-01');
    expect(social.nextMonthKey('2026-08')).toBe('2026-09');
  });

  it('rejects anything that is not YYYY-MM', () => {
    expect(social.isMonthKey('2026-13')).toBe(false);
    expect(social.isMonthKey('2026-00')).toBe(false);
    expect(social.isMonthKey('26-08')).toBe(false);
    expect(social.nextMonthKey('nope')).toBe(null);
  });

  it('knows how long each month is, including February in a leap year', () => {
    expect(social.daysInMonth('2026-02')).toBe(28);
    expect(social.daysInMonth('2028-02')).toBe(29);
    expect(social.daysInMonth('2026-09')).toBe(30);
    expect(social.daysInMonth('2026-08')).toBe(31);
  });
});

describe('local wall time to UTC', () => {
  it('resolves 9am Melbourne in winter (UTC+10)', () => {
    const at = social.zonedWallTimeToUtc(2026, 8, 10, 9, 0, 'Australia/Melbourne');
    expect(at.toISOString()).toBe('2026-08-09T23:00:00.000Z');
  });

  it('resolves 9am Melbourne in summer (UTC+11), not just a fixed offset', () => {
    const at = social.zonedWallTimeToUtc(2026, 1, 10, 9, 0, 'Australia/Melbourne');
    expect(at.toISOString()).toBe('2026-01-09T22:00:00.000Z');
  });

  it('handles a zone with no DST', () => {
    const at = social.zonedWallTimeToUtc(2026, 1, 10, 9, 0, 'Australia/Brisbane');
    expect(at.toISOString()).toBe('2026-01-09T23:00:00.000Z');
  });
});

describe('buildSchedule', () => {
  const base = { monthKey: '2026-09', slotTimes: ['09:00', '15:00'], perDay: 2, timeZone: 'Australia/Melbourne' };
  // Well before the month starts, so nothing is filtered as "already passed".
  const notBefore = '2026-08-01T00:00:00Z';

  it('lays 60 posts across a 30-day month, two a day', () => {
    const r = social.buildSchedule({ ...base, count: 60, notBefore });
    expect(r.ok).toBe(true);
    expect(r.slots).toHaveLength(60);
    expect(r.capacity).toBe(60);
  });

  it('puts the first two slots at 9am and 3pm local on the 1st', () => {
    const r = social.buildSchedule({ ...base, count: 4, notBefore });
    expect(r.slots[0]).toBe('2026-08-31T23:00:00.000Z'); // 1 Sep 09:00 AEST
    expect(r.slots[1]).toBe('2026-09-01T05:00:00.000Z'); // 1 Sep 15:00 AEST
    expect(r.slots[2]).toBe('2026-09-01T23:00:00.000Z'); // 2 Sep 09:00 AEST
  });

  it('keeps slots strictly increasing across a DST changeover', () => {
    // Melbourne moves to daylight time on the first Sunday of October.
    const r = social.buildSchedule({ ...base, monthKey: '2026-10', count: 20, notBefore: '2026-09-01T00:00:00Z' });
    expect(r.ok).toBe(true);
    for (let i = 1; i < r.slots.length; i++) {
      expect(new Date(r.slots[i]).getTime()).toBeGreaterThan(new Date(r.slots[i - 1]).getTime());
    }
  });

  it('never schedules into the past', () => {
    // Approving on the 15th must not dump the first half of the month as due.
    const r = social.buildSchedule({ ...base, count: 60, notBefore: '2026-09-15T04:00:00Z' });
    r.slots.forEach((s) => {
      expect(new Date(s).getTime()).toBeGreaterThan(new Date('2026-09-15T04:00:00Z').getTime());
    });
  });

  it('rejects a bad month or bad slot times instead of guessing', () => {
    expect(social.buildSchedule({ ...base, monthKey: 'later', count: 4 }).ok).toBe(false);
    expect(social.buildSchedule({ ...base, slotTimes: ['9am'], count: 4 }).ok).toBe(false);
    expect(social.buildSchedule({ ...base, slotTimes: ['25:00'], count: 4 }).ok).toBe(false);
  });
});

describe('assignSchedule', () => {
  const opts = { monthKey: '2026-09', slotTimes: ['09:00', '15:00'], perDay: 2, timeZone: 'Australia/Melbourne', notBefore: '2026-08-01T00:00:00Z' };

  it('pairs posts with slots in the order given', () => {
    const posts = [{ slot: 1 }, { slot: 2 }, { slot: 3 }];
    const r = social.assignSchedule(posts, opts);
    expect(r.ok).toBe(true);
    expect(r.assigned[0].publish_at).toBe('2026-08-31T23:00:00.000Z');
    expect(r.unscheduled).toBe(0);
  });

  it('reports overflow rather than silently dropping posts', () => {
    // 30-day month at 2/day holds 60. Ask it to hold 62.
    const posts = Array.from({ length: 62 }, (_, i) => ({ slot: i + 1 }));
    const r = social.assignSchedule(posts, opts);
    expect(r.assigned).toHaveLength(62);
    expect(r.unscheduled).toBe(2);
    expect(r.assigned[61].publish_at).toBe(null);
  });
});

describe('validatePost', () => {
  const good = { caption: 'A real caption.', image_path: 'x.jpg', image_width: 1080, image_height: 1350 };

  it('accepts the house 1080x1350 creative', () => {
    const v = social.validatePost(good, { facebook: true, instagram: true });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects an empty caption or a missing image', () => {
    expect(social.validatePost({ ...good, caption: '   ' }).ok).toBe(false);
    expect(social.validatePost({ caption: 'hi' }).ok).toBe(false);
  });

  it('rejects an aspect ratio Instagram will not take', () => {
    const v = social.validatePost({ ...good, image_width: 1080, image_height: 1920 }, { instagram: true });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/aspect ratio/);
  });

  it('does not apply the Instagram aspect rule to a Facebook-only post', () => {
    const v = social.validatePost(
      { ...good, image_width: 1080, image_height: 1920, targets: { facebook: true, instagram: false } }
    );
    expect(v.ok).toBe(true);
  });

  it('counts hashtags and rejects more than Instagram allows', () => {
    const tags = Array.from({ length: 31 }, (_, i) => '#tag' + i).join(' ');
    const v = social.validatePost({ ...good, caption: 'Hello ' + tags }, { instagram: true });
    expect(social.countHashtags('a #one #two')).toBe(2);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/hashtags/);
  });

  it('warns, without blocking, on leftover placeholders and em dashes', () => {
    const v = social.validatePost({ ...good, caption: 'Insert [real quote] here — soon.' });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/placeholder/);
    expect(v.warnings.join(' ')).toMatch(/em dash/);
  });
});

describe('canApproveCampaign', () => {
  const campaign = { targets: { facebook: true, instagram: true } };
  const ok = (slot) => ({ slot, status: 'approved', caption: 'Fine.', image_path: 'a.jpg', image_width: 1080, image_height: 1350 });

  it('refuses while any post is still undecided', () => {
    const r = social.canApproveCampaign(campaign, [ok(1), { ...ok(2), status: 'draft' }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/need a decision/);
  });

  it('refuses when an approved post fails validation', () => {
    const r = social.canApproveCampaign(campaign, [ok(1), { ...ok(2), caption: '' }]);
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
  });

  it('refuses a campaign where everything was rejected', () => {
    const r = social.canApproveCampaign(campaign, [{ ...ok(1), status: 'rejected' }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/every post is rejected/);
  });

  it('approves when every post is decided and valid', () => {
    const r = social.canApproveCampaign(campaign, [ok(1), ok(2), { ...ok(3), status: 'rejected' }]);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
  });
});

describe('selectDuePosts', () => {
  const now = '2026-09-05T00:00:00Z';
  const p = (over) => ({ status: 'approved', publish_at: '2026-09-04T23:00:00Z', attempts: 0, ...over });

  it('takes approved posts whose time has passed, oldest first', () => {
    const due = social.selectDuePosts([
      p({ slot: 2, publish_at: '2026-09-04T23:00:00Z' }),
      p({ slot: 1, publish_at: '2026-09-03T23:00:00Z' })
    ], now, 10);
    expect(due.map((x) => x.slot)).toEqual([1, 2]);
  });

  it('never takes a post that is not approved, even if its time has passed', () => {
    expect(social.selectDuePosts([p({ status: 'draft' })], now, 10)).toHaveLength(0);
    expect(social.selectDuePosts([p({ status: 'rejected' })], now, 10)).toHaveLength(0);
    expect(social.selectDuePosts([p({ status: 'posted' })], now, 10)).toHaveLength(0);
  });

  it('never takes a post with no publish_at, which is how unreviewed work is fenced off', () => {
    expect(social.selectDuePosts([p({ publish_at: null })], now, 10)).toHaveLength(0);
  });

  it('leaves future posts alone', () => {
    expect(social.selectDuePosts([p({ publish_at: '2026-09-06T00:00:00Z' })], now, 10)).toHaveLength(0);
  });

  it('gives up on a post that has already burned its attempts', () => {
    expect(social.selectDuePosts([p({ attempts: social.MAX_PUBLISH_ATTEMPTS })], now, 10)).toHaveLength(0);
  });

  it('caps how much one run will take on', () => {
    const many = Array.from({ length: 20 }, (_, i) => p({ slot: i }));
    expect(social.selectDuePosts(many, now, 4)).toHaveLength(4);
  });
});

describe('publishPost', () => {
  const cfg = { pageId: '123', pageToken: 'tok', igUserId: '456', disabled: false };
  const post = { caption: 'Hello.', targets: { facebook: true, instagram: true } };

  function fakeFetch(routes) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? String(init.body) : null });
      for (const [match, payload] of routes) {
        if (String(url).includes(match)) {
          return { ok: true, status: 200, json: async () => payload };
        }
      }
      return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) };
    };
    impl.calls = calls;
    return impl;
  }

  it('posts to Facebook and Instagram and returns both ids', async () => {
    const fetchImpl = fakeFetch([
      ['/photos', { id: 'p1', post_id: 'page_1' }],
      ['/media_publish', { id: 'ig_media_1' }],
      ['status_code', { status_code: 'FINISHED' }],
      ['/media', { id: 'creation_1' }]
    ]);
    const r = await social.publishPost(post, { config: cfg, imageUrl: 'https://x/i.jpg', fetchImpl, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.facebook.postId).toBe('page_1');
    expect(r.instagram.mediaId).toBe('ig_media_1');
  });

  it('waits for the Instagram container instead of publishing immediately', async () => {
    let checks = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/media_publish')) return { ok: true, status: 200, json: async () => ({ id: 'ig1' }) };
      if (u.includes('status_code')) {
        checks++;
        return { ok: true, status: 200, json: async () => ({ status_code: checks < 3 ? 'IN_PROGRESS' : 'FINISHED' }) };
      }
      if (u.includes('/media')) return { ok: true, status: 200, json: async () => ({ id: 'c1' }) };
      return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
    };
    const r = await social.publishPost(
      { ...post, targets: { facebook: false, instagram: true } },
      { config: cfg, imageUrl: 'https://x/i.jpg', fetchImpl, sleep: async () => {} }
    );
    expect(checks).toBe(3);
    expect(r.ok).toBe(true);
  });

  it('does not re-post to a network that already succeeded', async () => {
    const fetchImpl = fakeFetch([['/media', { id: 'c1' }], ['status_code', { status_code: 'FINISHED' }], ['/media_publish', { id: 'ig1' }]]);
    await social.publishPost(
      { ...post, facebook_post_id: 'already_there' },
      { config: cfg, imageUrl: 'https://x/i.jpg', fetchImpl, sleep: async () => {} }
    );
    expect(fetchImpl.calls.some((c) => c.url.includes('/photos'))).toBe(false);
  });

  it('reports a partial failure without losing the network that worked', async () => {
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/photos')) return { ok: true, status: 200, json: async () => ({ post_id: 'fb1' }) };
      return { ok: false, status: 400, json: async () => ({ error: { message: 'bad image' } }) };
    };
    const r = await social.publishPost(post, { config: cfg, imageUrl: 'https://x/i.jpg', fetchImpl, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.facebook.postId).toBe('fb1');
    expect(r.errors.join(' ')).toMatch(/Instagram/);
  });

  it('publishes nothing at all when the kill switch is on', async () => {
    const r = await social.publishPost(post, { config: { ...cfg, disabled: true }, imageUrl: 'https://x/i.jpg' });
    expect(r.ok).toBe(false);
    expect(r.disabled).toBe(true);
  });
});

describe('graphConfigProblems', () => {
  it('names exactly what is missing for the networks in play', () => {
    const none = social.graphConfig({});
    expect(social.graphConfigProblems(none, { facebook: true, instagram: true })).toHaveLength(3);
    const fbOnly = social.graphConfig({ FB_PAGE_ACCESS_TOKEN: 't', FB_PAGE_ID: '1' });
    expect(social.graphConfigProblems(fbOnly, { facebook: true, instagram: false })).toEqual([]);
    expect(social.graphConfigProblems(fbOnly, { facebook: true, instagram: true })).toEqual(['IG_USER_ID is not set.']);
  });
});
