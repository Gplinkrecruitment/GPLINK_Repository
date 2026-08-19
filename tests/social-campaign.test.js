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

  // ── topping a part-scheduled month up ──────────────────────────────────────
  // A month can be scheduled in batches now, so a later run must skip the slots the
  // earlier batch already holds. Handing the same minute out twice would stack two
  // posts on it, and the publisher would fire both in the same run.
  it('never hands out a slot another post already holds', () => {
    const first = social.assignSchedule([{ slot: 1 }, { slot: 2 }], opts);
    const taken = first.assigned.map((p) => p.publish_at);
    const second = social.assignSchedule([{ slot: 3 }], Object.assign({}, opts, { exclude: taken }));
    expect(second.ok).toBe(true);
    expect(taken).not.toContain(second.assigned[0].publish_at);
    // The first batch took both of day 1's slots (09:00 and 15:00 AEST), so the next
    // free one is day 2 at 09:00. It takes that, not a re-flow from the top.
    expect(taken).toEqual(['2026-08-31T23:00:00.000Z', '2026-09-01T05:00:00.000Z']);
    expect(second.assigned[0].publish_at).toBe('2026-09-01T23:00:00.000Z');
  });

  it('a freed slot (a scheduled post later rejected) becomes available again', () => {
    const all = social.assignSchedule([{ slot: 1 }, { slot: 2 }, { slot: 3 }], opts);
    const slots = all.assigned.map((p) => p.publish_at);
    // Slot 2 is rejected, so only 1 and 3 still hold dates.
    const stillTaken = [slots[0], slots[2]];
    const topUp = social.assignSchedule([{ slot: 4 }], Object.assign({}, opts, { exclude: stillTaken }));
    expect(topUp.assigned[0].publish_at).toBe(slots[1]);
  });

  it('reports how many slots were still free, so a top-up that did not fit is visible', () => {
    const full = social.assignSchedule(
      Array.from({ length: 60 }, (_, i) => ({ slot: i + 1 })), opts
    );
    const taken = full.assigned.map((p) => p.publish_at).filter(Boolean);
    expect(taken).toHaveLength(60);
    const topUp = social.assignSchedule([{ slot: 61 }], Object.assign({}, opts, { exclude: taken }));
    expect(topUp.free).toBe(0);
    expect(topUp.unscheduled).toBe(1);
    expect(topUp.assigned[0].publish_at).toBe(null);
    // capacity stays the month's whole capacity; `free` is what this run could use.
    expect(topUp.capacity).toBe(60);
  });

  it('an exclude list of junk is ignored rather than throwing', () => {
    const r = social.assignSchedule([{ slot: 1 }], Object.assign({}, opts, { exclude: ['not-a-date', null, undefined] }));
    expect(r.ok).toBe(true);
    expect(r.assigned[0].publish_at).toBe('2026-08-31T23:00:00.000Z');
  });

  // ── "start posting from today" ─────────────────────────────────────────────
  // A month-bounded schedule can only ever answer "1 <campaign month>". The owner
  // approved September's batch on 18 August and wanted it going out immediately
  // (2026-08-18), so `startFrom` begins on a given day and rolls forward past the
  // month's end. The month key stays the batch's NAME; it stops being a fence.
  describe('startFrom rolls the batch forward from a given day', () => {
    const from = { monthKey: '2026-09', slotTimes: ['09:00', '15:00'], perDay: 2, timeZone: 'Australia/Melbourne' };

    it('starts on the day given, not on the first of the campaign month', () => {
      const r = social.assignSchedule([{ slot: 1 }, { slot: 2 }], Object.assign({}, from, {
        startFrom: '2026-08-17T17:35:00Z', notBefore: '2026-08-17T17:35:00Z'
      }));
      expect(r.ok).toBe(true);
      // 18 Aug 09:00 and 15:00 Melbourne (AEST, UTC+10) = 17 Aug 23:00Z and 18 Aug 05:00Z.
      expect(r.assigned[0].publish_at).toBe('2026-08-17T23:00:00.000Z');
      expect(r.assigned[1].publish_at).toBe('2026-08-18T05:00:00.000Z');
    });

    it('rolls straight past the end of the starting month', () => {
      // 30 posts at 2/day from 18 Aug runs into September, which a month-fenced
      // schedule could never express.
      const posts = Array.from({ length: 30 }, (_, i) => ({ slot: i + 1 }));
      const r = social.assignSchedule(posts, Object.assign({}, from, {
        startFrom: '2026-08-17T17:35:00Z', notBefore: '2026-08-17T17:35:00Z'
      }));
      expect(r.unscheduled).toBe(0);
      expect(r.assigned.every((p) => p.publish_at)).toBe(true);
      expect(r.assigned[0].publish_at.slice(0, 7)).toBe('2026-08');
      expect(r.assigned[29].publish_at.slice(0, 7)).toBe('2026-09');
      // Strictly increasing, no duplicates.
      const dates = r.assigned.map((p) => p.publish_at);
      expect(new Set(dates).size).toBe(30);
      expect([...dates].sort()).toEqual(dates);
    });

    it('never books a slot that has already passed today', () => {
      // 03:35 Melbourne on the 18th takes today's 09:00; 10:30 Melbourne has missed it
      // and must take 15:00 instead.
      const r = social.assignSchedule([{ slot: 1 }], Object.assign({}, from, {
        startFrom: '2026-08-17T17:35:00Z', notBefore: '2026-08-17T17:35:00Z'
      }));
      expect(r.assigned[0].publish_at).toBe('2026-08-17T23:00:00.000Z');
      const later = social.assignSchedule([{ slot: 1 }], Object.assign({}, from, {
        startFrom: '2026-08-18T00:30:00Z', notBefore: '2026-08-18T01:00:00Z'
      }));
      expect(later.assigned[0].publish_at).toBe('2026-08-18T05:00:00.000Z');
    });

    it('still skips slots another post already holds', () => {
      const r = social.assignSchedule([{ slot: 1 }], Object.assign({}, from, {
        startFrom: '2026-08-17T17:35:00Z', notBefore: '2026-08-17T17:35:00Z',
        exclude: ['2026-08-17T23:00:00.000Z']
      }));
      expect(r.assigned[0].publish_at).toBe('2026-08-18T05:00:00.000Z');
    });

    it('refuses a start date it cannot read rather than guessing', () => {
      const r = social.assignSchedule([{ slot: 1 }], Object.assign({}, from, { startFrom: 'whenever' }));
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid_start_from');
    });
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

  // CONTRACT CHANGED 2026-08-18 (owner: "I should be able to approve and schedule in
  // less than all of the creatives"). This used to refuse while ANY post was still
  // undecided, which left 19 reviewed posts stranded behind 11 unread ones. An
  // undecided post can never publish — selectDuePosts requires an 'approved' status
  // AND a publish_at, and a date is only ever written to an approved post — so it has
  // no business gating the batch that IS ready.
  it('schedules the ready batch while other posts are still undecided', () => {
    const r = social.canApproveCampaign(campaign, [ok(1), { ...ok(2), status: 'draft' }]);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.undecided).toBe(1);
  });

  it('refuses when there is nothing NEW to schedule but work is still undecided', () => {
    // Everything approved already holds a date, so this click would book nothing.
    const r = social.canApproveCampaign(campaign, [
      { ...ok(1), publish_at: '2026-09-01T23:00:00Z' },
      { ...ok(2), status: 'draft' }
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Approve at least one of the 1 post/);
  });

  it('refuses a second identical click once every approved post has a date', () => {
    const r = social.canApproveCampaign(campaign, [{ ...ok(1), publish_at: '2026-09-01T23:00:00Z' }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already has a date/);
  });

  it('only validates the batch being scheduled, not an undecided post', () => {
    // A broken draft is not going out either way; blocking on it would re-create
    // exactly the dead end this change removed.
    const r = social.canApproveCampaign(campaign, [ok(1), { ...ok(2), status: 'draft', caption: '' }]);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
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

describe('configuredTargets', () => {
  // Instagram needs a Business account, a Page link and a use case that Facebook
  // does not, so the two are routinely ready weeks apart. A campaign must target
  // what is actually configured, or every post on a Facebook-only setup burns an
  // Instagram failure against its retry budget and eventually parks as 'failed'
  // despite having published perfectly well to the Page.
  const conf = (over) => social.graphConfig(Object.assign(
    { FB_PAGE_ACCESS_TOKEN: 'tok', FB_PAGE_ID: '1', IG_USER_ID: '2' }, over || {}
  ));

  it('targets both when both are configured', () => {
    expect(social.configuredTargets(conf())).toEqual({ facebook: true, instagram: true });
    expect(social.nothingConfigured(conf())).toBe(false);
  });

  it('drops Instagram when IG_USER_ID is missing', () => {
    expect(social.configuredTargets(conf({ IG_USER_ID: '' })))
      .toEqual({ facebook: true, instagram: false });
  });

  it('drops Facebook when FB_PAGE_ID is missing', () => {
    expect(social.configuredTargets(conf({ FB_PAGE_ID: '' })))
      .toEqual({ facebook: false, instagram: true });
  });

  it('treats a missing token as nothing configured, since both networks need it', () => {
    const none = conf({ FB_PAGE_ACCESS_TOKEN: '' });
    expect(social.configuredTargets(none)).toEqual({ facebook: false, instagram: false });
    expect(social.nothingConfigured(none)).toBe(true);
  });

  it('catches IG_USER_ID being set to the Page id, which Meta reports opaquely', () => {
    // Real incident: the Page id was pasted into both variables. Facebook kept
    // working, and Instagram failed with "Object with ID ... does not support
    // this operation", which reads as a permissions problem.
    const wrong = social.graphConfig({
      FB_PAGE_ACCESS_TOKEN: 'tok', FB_PAGE_ID: '769864969547691', IG_USER_ID: '769864969547691'
    });
    expect(social.configuredTargets(wrong)).toEqual({ facebook: true, instagram: false });
    const problems = social.graphConfigProblems(wrong, { facebook: true, instagram: true });
    expect(problems.join(' ')).toMatch(/set to the Facebook Page id/);
  });

  it('a genuine Instagram id is accepted', () => {
    const right = social.graphConfig({
      FB_PAGE_ACCESS_TOKEN: 'tok', FB_PAGE_ID: '769864969547691', IG_USER_ID: '17841400000000000'
    });
    expect(social.configuredTargets(right)).toEqual({ facebook: true, instagram: true });
    expect(social.graphConfigProblems(right, { facebook: true, instagram: true })).toEqual([]);
  });

  it('a Facebook-only campaign reports no configuration problems', () => {
    const fbOnly = conf({ IG_USER_ID: '' });
    expect(social.graphConfigProblems(fbOnly, social.configuredTargets(fbOnly))).toEqual([]);
  });

  it('a Facebook-only post publishes and is never touched by the missing Instagram', async () => {
    const fbOnly = conf({ IG_USER_ID: '' });
    const fetchImpl = async (url) => String(url).includes('/photos')
      ? { ok: true, status: 200, json: async () => ({ post_id: 'fb1' }) }
      : { ok: false, status: 400, json: async () => ({ error: { message: 'should not be called' } }) };
    const r = await social.publishPost(
      { caption: 'Hi.', targets: social.configuredTargets(fbOnly) },
      { config: fbOnly, imageUrl: 'https://x/i.jpg', fetchImpl }
    );
    expect(r.ok).toBe(true);
    expect(r.facebook.postId).toBe('fb1');
    expect(r.instagram).toBe(null);
  });
});

// Turning a second network ON must never stop the first one going out. The
// publisher used to hold a whole post whenever ANY network it wanted was
// unconfigured, so setting targets to {facebook, instagram} before IG_USER_ID
// existed would have silently stopped Facebook too.
describe('publishableTargets', () => {
  const fbOnly = { pageId: '123', pageToken: 'tok', igUserId: '' };
  const both = { pageId: '123', pageToken: 'tok', igUserId: '17841400000000000' };
  const none = { pageId: '', pageToken: '', igUserId: '' };

  it('publishes the network that IS configured and marks the other as waiting', () => {
    const r = social.publishableTargets({ facebook: true, instagram: true }, fbOnly);
    expect(r.publishable).toEqual({ facebook: true, instagram: false });
    expect(r.waiting).toEqual({ facebook: false, instagram: true });
  });

  it('publishes to both when both are configured', () => {
    const r = social.publishableTargets({ facebook: true, instagram: true }, both);
    expect(r.publishable).toEqual({ facebook: true, instagram: true });
    expect(r.waiting).toEqual({ facebook: false, instagram: false });
  });

  it('a network the post does not want is neither published nor waiting', () => {
    const r = social.publishableTargets({ facebook: true, instagram: false }, fbOnly);
    expect(r.publishable).toEqual({ facebook: true, instagram: false });
    expect(r.waiting).toEqual({ facebook: false, instagram: false });
  });

  it('nothing publishable when nothing is configured, which is the hold case', () => {
    const r = social.publishableTargets({ facebook: true, instagram: true }, none);
    expect(r.publishable).toEqual({ facebook: false, instagram: false });
    expect(r.waiting).toEqual({ facebook: true, instagram: true });
  });

  it('an IG_USER_ID holding the Page id counts as waiting, not publishable', () => {
    const r = social.publishableTargets({ facebook: true, instagram: true },
      { pageId: '123', pageToken: 'tok', igUserId: '123' });
    expect(r.publishable.instagram).toBe(false);
    expect(r.waiting.instagram).toBe(true);
    // ...and Facebook still goes out.
    expect(r.publishable.facebook).toBe(true);
  });

  it('defaults to wanting both when a post carries no targets', () => {
    const r = social.publishableTargets(null, both);
    expect(r.publishable).toEqual({ facebook: true, instagram: true });
  });
});

describe('split Meta tokens, with a shared fallback', () => {
  // FB_PAGE_ACCESS_TOKEN was one variable read by two features needing different
  // scopes. Minting for one broke the other, in both directions: social work
  // killed lead capture on 2026-08-16, lead work killed posting on 08-18. The
  // split exists so that can no longer happen; the fallback exists so shipping
  // it changes nothing until the new variables are actually set.

  it('falls back to the shared variable, so shipping the split changes nothing', () => {
    const cfg = social.graphConfig({ FB_PAGE_ACCESS_TOKEN: 'shared' });
    expect(cfg.pageToken).toBe('shared');
    expect(cfg.pageTokenSource).toBe('FB_PAGE_ACCESS_TOKEN');
    expect(cfg.sharingLeadToken).toBe(true);
  });

  it('prefers the social variable once it is set', () => {
    const cfg = social.graphConfig({
      FB_PAGE_ACCESS_TOKEN: 'shared', FB_SOCIAL_PAGE_TOKEN: 'social-only'
    });
    expect(cfg.pageToken).toBe('social-only');
    expect(cfg.pageTokenSource).toBe('FB_SOCIAL_PAGE_TOKEN');
    // No longer drawing on the value lead capture depends on.
    expect(cfg.sharingLeadToken).toBe(false);
  });

  it('is unaffected by the LEADS variable, which is the whole point', () => {
    // Setting a leads token must never change what the publisher uses. This is
    // the exact collision that broke posting on 2026-08-18.
    const before = social.graphConfig({ FB_PAGE_ACCESS_TOKEN: 'shared' }).pageToken;
    const after = social.graphConfig({
      FB_PAGE_ACCESS_TOKEN: 'shared', FB_LEADS_PAGE_TOKEN: 'leads-only'
    }).pageToken;
    expect(after).toBe(before);
    expect(after).not.toBe('leads-only');
  });

  it('reports nothing configured when neither variable is set', () => {
    const cfg = social.graphConfig({});
    expect(cfg.pageToken).toBe('');
    expect(cfg.sharingLeadToken).toBe(false);
    expect(social.nothingConfigured(cfg)).toBe(true);
  });

  it('names the variable the operator must actually fix', () => {
    const shared = social.graphConfig({ FB_PAGE_ID: '1', IG_USER_ID: '2' });
    expect(social.graphConfigProblems(shared, { facebook: true, instagram: true })
      .join(' ')).toMatch(/FB_PAGE_ACCESS_TOKEN is not set/);

    // Once the social variable is the declared source, an empty value should
    // point at THAT name, not the shared one that is right for neither.
    const split = social.graphConfig({ FB_SOCIAL_PAGE_TOKEN: '   ', FB_PAGE_ID: '1' });
    expect(split.pageTokenSource).toBe('FB_PAGE_ACCESS_TOKEN');
  });
});

describe('isCredentialError', () => {
  // Real incident, 2026-08-18: a bad paste into FB_PAGE_ACCESS_TOKEN produced
  // "Malformed access token" on every post as it came due. Two creatives burned
  // three attempts each and retired themselves before anyone noticed, and the
  // rest of the month was queued to do the same, one post at a time.
  it('recognises the wordings Meta uses for a bad or expired token', () => {
    [
      'Malformed access token',
      '(#190) Invalid OAuth access token - Cannot parse access token',
      'Error validating access token: Session has expired',
      'The user has not authorized application',
      '(#190) This method must be called with a Page Access Token'
    ].forEach(function (m) {
      expect(social.isCredentialError(m), m).toBe(true);
    });
  });

  it('does not swallow real content problems, which SHOULD burn attempts', () => {
    [
      'The image is too large',
      'Instagram could not process the image (ERROR)',
      'Unsupported post request. Object with ID x does not support this operation',
      ''
    ].forEach(function (m) {
      expect(social.isCredentialError(m), m).toBe(false);
    });
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
