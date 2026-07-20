'use strict';

// Convert a wall-clock time (date + minutes-from-midnight) in an IANA tz to a UTC Date,
// using Intl to discover the tz's offset on that date (DST-correct). minutesFromMidnight
// may exceed 1440 to mean "into the next day".
function wallTimeToUtc(dateYMD, minutesFromMidnight, tz) {
  var parts = dateYMD.split('-');
  var y = Number(parts[0]), mo = Number(parts[1]), d = Number(parts[2]);
  var addDays = Math.floor(minutesFromMidnight / 1440);
  var mins = minutesFromMidnight - addDays * 1440;
  var hh = Math.floor(mins / 60), mm = mins % 60;
  // Guess UTC, then correct by the tz offset at that instant.
  var guess = Date.UTC(y, mo - 1, d + addDays, hh, mm, 0);
  var offset = tzOffsetMs(guess, tz);
  var utc = guess - offset;
  // re-evaluate once in case the guess crossed a DST boundary
  var offset2 = tzOffsetMs(utc, tz);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

// Offset (ms) of tz at a given UTC instant = (local wall time interpreted as UTC) - instant.
function tzOffsetMs(utcMillis, tz) {
  var dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  var p = {}; dtf.formatToParts(new Date(utcMillis)).forEach(function (x) { p[x.type] = x.value; });
  var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return asUtc - utcMillis;
}

function ymdInTz(utcMillis, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcMillis));
}
function dowInTz(utcMillis, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(utcMillis));
}
function isWeekendDow(dow) { return dow === 'Sat' || dow === 'Sun'; }

function formatLocal(utcIso, tz) {
  var d = new Date(utcIso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(d);
}

// Build [start,end) UTC intervals for one party for the local date `ymd` (its own tz).
function partyIntervalsForDate(party, ymd, tz) {
  var sample = wallTimeToUtc(ymd, 12 * 60, tz).getTime(); // noon, to read the weekday safely
  var weekend = isWeekendDow(dowInTz(sample, tz));
  var win = weekend ? party.weekend : party.weekday;
  if (party.overrides && party.overrides.length) {
    var ov = party.overrides.filter(function (o) { return o.date === ymd; });
    if (ov.length) {
      return ov.map(function (o) {
        // Availability windows submitted from the practice contact's browser
        // carry the DEVICE tz (o.tz). Interpret those wall-clock minutes in
        // THAT tz; windows without one (or with a bad string — probed, so a
        // poisoned row can never blank the whole slot computation) keep the
        // party's derived tz.
        var oTz = tz;
        if (o.tz) {
          try { new Intl.DateTimeFormat('en', { timeZone: o.tz }); oTz = o.tz; } catch (e) { oTz = tz; }
        }
        return { start: wallTimeToUtc(ymd, o.fromMin, oTz).getTime(), end: wallTimeToUtc(ymd, o.toMin, oTz).getTime() };
      });
    }
  }
  if (!win || win[0] === win[1]) return [];
  return [{ start: wallTimeToUtc(ymd, win[0], tz).getTime(), end: wallTimeToUtc(ymd, win[1], tz).getTime() }];
}

function intersect(aList, bList) {
  var out = [];
  aList.forEach(function (a) {
    bList.forEach(function (b) {
      var s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
      if (e > s) out.push({ start: s, end: e });
    });
  });
  return out;
}

function subtractBusy(list, busy) {
  var res = list.slice();
  busy.forEach(function (b) {
    var bs = new Date(b.startUtc).getTime(), be = new Date(b.endUtc).getTime();
    var next = [];
    res.forEach(function (iv) {
      if (be <= iv.start || bs >= iv.end) { next.push(iv); return; }
      if (bs > iv.start) next.push({ start: iv.start, end: Math.min(bs, iv.end) });
      if (be < iv.end) next.push({ start: Math.max(be, iv.start), end: iv.end });
    });
    res = next;
  });
  return res;
}

function computeInterviewSlots(opts) {
  var now = new Date(opts.now).getTime();
  var horizonDays = opts.horizonDays || 14;
  var durationMin = opts.durationMin || 45;
  var leadHours = opts.leadHours != null ? opts.leadHours : 48;
  var gridMin = opts.gridMin || 30;
  var maxSlots = opts.maxSlots || 12;
  var host = opts.host, practice = opts.practice, gp = opts.gp, busy = opts.busy || [];
  var earliest = now + leadHours * 3600 * 1000;
  var horizonTo = now + horizonDays * 24 * 3600 * 1000;

  var slots = [];
  // iterate dates in the HOST tz across the horizon
  for (var dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    var ymdHost = ymdInTz(now + dayOffset * 24 * 3600 * 1000, host.tz);
    var hostIv = partyIntervalsForDate(host, ymdHost, host.tz);
    if (!hostIv.length) continue;
    hostIv = subtractBusy(hostIv, busy);
    // practice/gp evaluated on the local date that the host interval falls within
    var combined = [];
    hostIv.forEach(function (h) {
      var ymdP = ymdInTz(h.start, practice.tz), ymdP2 = ymdInTz(h.end - 1, practice.tz);
      var pIv = partyIntervalsForDate(practice, ymdP, practice.tz);
      if (ymdP2 !== ymdP) pIv = pIv.concat(partyIntervalsForDate(practice, ymdP2, practice.tz));
      var ymdG = ymdInTz(h.start, gp.tz), ymdG2 = ymdInTz(h.end - 1, gp.tz);
      var gIv = partyIntervalsForDate(gp, ymdG, gp.tz);
      if (ymdG2 !== ymdG) gIv = gIv.concat(partyIntervalsForDate(gp, ymdG2, gp.tz));
      var step1 = intersect([h], pIv);
      combined = combined.concat(intersect(step1, gIv));
    });
    // slice into grid starts
    combined.forEach(function (iv) {
      var start = Math.ceil(iv.start / (gridMin * 60000)) * (gridMin * 60000);
      for (var t = start; t + durationMin * 60000 <= iv.end; t += gridMin * 60000) {
        if (t < earliest || t > horizonTo) continue;
        slots.push(t);
      }
    });
  }
  slots = Array.from(new Set(slots)).sort(function (a, b) { return a - b; });
  // spread: take evenly across the list up to maxSlots
  if (slots.length > maxSlots) {
    var picked = [], stepN = slots.length / maxSlots;
    for (var i = 0; i < maxSlots; i++) picked.push(slots[Math.floor(i * stepN)]);
    slots = picked;
  }
  return {
    horizonFromUtc: new Date(now).toISOString(),
    horizonToUtc: new Date(horizonTo).toISOString(),
    slots: slots.map(function (t) {
      var startUtc = new Date(t).toISOString();
      var endUtc = new Date(t + durationMin * 60000).toISOString();
      return {
        startUtc: startUtc, endUtc: endUtc,
        local: {
          host: { tz: host.tz, label: formatLocal(startUtc, host.tz) },
          practice: { tz: practice.tz, label: formatLocal(startUtc, practice.tz) },
          gp: { tz: gp.tz, label: formatLocal(startUtc, gp.tz) }
        }
      };
    })
  };
}

module.exports = { wallTimeToUtc, tzOffsetMs, formatLocal, computeInterviewSlots };
