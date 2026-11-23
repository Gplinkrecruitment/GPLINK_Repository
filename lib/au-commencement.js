'use strict';
const auSafeText = require('./au-safe-text.js');   // FR-1 (R-07)
/**
 * WP-13 (Australian GP build): commencement, invoice tracking, early exit and
 * the daily lifecycle job. This file does the reading and writing; every rule
 * and every word lives in a pure module beside it:
 *
 *   lib/au-placement-fees.js      the agreement's fee, guarantee and credit terms
 *   lib/au-lifecycle.js           validation, the staff tasks, what is due when
 *   lib/au-placement-messages.js  N18, N19, N20
 *
 * server.js builds one instance with createAuCommencement(ctx), handing in its
 * own guarded helpers (the database request, the once-ever ledger, the task
 * and timeline writers, the stage mover, the guarded message senders). Nothing
 * here talks to an outside service directly, and NOTHING talks to Xero: the
 * "invoice" is a staff task and three dates a person types in.
 *
 * Everything is behind the switch (ctx.switchOn(), read at call time) and
 * only ever acts for a doctor on an Australian pathway. An overseas placement,
 * and every placement with the switch off, is never read or written here.
 */

const fees = require('./au-placement-fees.js');
const lifecycle = require('./au-lifecycle.js');
const messages = require('./au-placement-messages.js');
const agreementVariants = require('./agreement-variants.js');
const candidatePathway = require('./candidate-pathway.js');
const journeyLadders = require('./journey-ladders.js');
const auTimezone = require('./au-timezone.js');
const auQuietHours = require('./au-quiet-hours.js');
const auWhatsAppTemplates = require('./au-whatsapp-templates.js');
const auSweeps = require('./au-sweeps.js');
const auPrestart = require('./au-prestart.js');
const auGpApp = require('./au-gp-app.js');
const documentRequirements = require('./document-requirements.js');
const documentCountry = require('./document-country.js');

// FB-2a (W3-D21): what staff are shown for a required pre-start document that
// is not yet approved (the staff label from the one document list).
function prestartDocumentLabels(keys, pathwayResult) {
  let items = [];
  try { items = documentRequirements.auDocumentRequirements(pathwayResult).items || []; } catch (e) { items = []; }
  return (Array.isArray(keys) ? keys : []).map(function (key) {
    const item = items.filter(function (d) { return d && d.key === key; })[0] || null;
    return 'Document not yet approved: ' + ((item && (item.staffLabel || item.label)) || key);
  });
}

const KIND = lifecycle.KIND;
const REASON_MIN = 10;

function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }
function cleanText(value, max) {
  return auSafeText.safeText(value, max || 300);   // FR-1 (R-07): the one shared helper
}
function fail(status, code, message, extra) {
  return Object.assign({ ok: false, status, code, message }, extra || {});
}
function isOpenTask(t) { return t && t.status !== 'completed' && t.status !== 'cancelled'; }
function byPlacedDesc(a, b) {
  return String(b.placed_at || b.created_at || '').localeCompare(String(a.placed_at || a.created_at || ''));
}

function createAuCommencement(ctx) {
  const db = ctx.db;
  const nowMs = function () { return typeof ctx.now === 'function' ? ctx.now() : Date.now(); };

  // ── reads ──────────────────────────────────────────────────────────────────

  /** Every placement row of one doctor, newest first. null = could not be read. */
  async function placementRowsFor(userId) {
    const read = await db('placements', 'select=*&user_id=eq.' + enc(userId) + '&limit=50');
    if (!read.ok || !Array.isArray(read.data)) return null;
    return read.data.slice().sort(byPlacedDesc);
  }

  // The placement the commercial actions are about: the newest active row,
  // else the newest row of any status (an ended placement still has an
  // invoice to mark paid and a credit to decide).
  function currentRow(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.filter(function (r) { return r && r.status === 'active'; })[0] || list[0] || null;
  }

  // The shape server.js's own placement helpers use (_auActivePlacementFor).
  function shapeOf(row) {
    return {
      key: row.application_id ? String(row.application_id) : String(row.id),
      applicationId: row.application_id ? String(row.application_id) : null,
      row,
      beingWritten: false,
      startDate: auPrestart.cleanDay(row.start_date),
      placedAt: row.placed_at || row.created_at || null,
      practiceName: String(row.practice_name || '').trim(),
      practiceId: row.practice_id || null,
      jobTitle: String(row.job_title || '').trim()
    };
  }

  async function practiceFor(row) {
    if (!row || !row.practice_id) return null;
    try { return await ctx.getPractice(row.practice_id); } catch (e) { return null; }
  }
  function zoneFor(practice) {
    let zone = '';
    try { zone = auTimezone.zoneForAuState(practice && practice.location_state) || ''; } catch (e) { zone = ''; }
    // No practice on the placement, no state on it, or not an Australian
    // state: the documented fallback (Sydney).
    return zone || lifecycle.FALLBACK_ZONE;
  }

  /**
   * "Today" for each of a list of placement rows: the calendar date at that
   * row's practice (one read of the practices' states; the fallback zone for
   * a row with no practice or an unreadable one). For lists that span
   * practices (exports, the commercial summary).
   * @returns {Promise<(row: object) => string>}
   */
  async function practiceDays(rows, atMs) {
    const at = Number.isFinite(atMs) ? atMs : nowMs();
    const ids = Array.from(new Set((Array.isArray(rows) ? rows : []).map(function (r) { return r && r.practice_id ? String(r.practice_id) : ''; }).filter(Boolean)));
    const zoneById = {};
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const read = await db('practices', 'select=id,location_state&id=in.(' + ids.slice(i, i + 100).map(enc).join(',') + ')&limit=200');
        (read.ok && Array.isArray(read.data) ? read.data : []).forEach(function (p) { zoneById[String(p.id)] = zoneFor(p); });
      } catch (e) { /* the fallback zone for these */ }
    }
    const fallbackDay = lifecycle.localDay(at, lifecycle.FALLBACK_ZONE);
    const dayByZone = {};
    return function (row) {
      const zone = row && row.practice_id ? zoneById[String(row.practice_id)] : '';
      if (!zone) return fallbackDay;
      if (!dayByZone[zone]) dayByZone[zone] = lifecycle.localDay(at, zone);
      return dayByZone[zone];
    };
  }
  function todayAt(practice) { return lifecycle.localDay(nowMs(), zoneFor(practice)); }

  /**
   * The case, the doctor's pathway and their placement rows, or the answer to
   * send instead. An overseas doctor: 409 not_au_pathway, and nothing about a
   * placement has been read.
   */
  async function load(caseId) {
    if (!ctx.switchOn()) return { error: fail(404, null, 'Not found') };
    if (!ctx.dbConfigured()) return { error: fail(503, null, 'Requires Supabase.') };
    const read = await db('registration_cases',
      'select=id,user_id,stage,status,created_at,completed_at,assigned_va,assigned_rso&id=eq.' + enc(caseId) + '&limit=1');
    const caseRow = read.ok && Array.isArray(read.data) && read.data[0] ? read.data[0] : null;
    if (!caseRow) return { error: fail(404, 'case_not_found', 'Case not found.') };
    let p = null;
    try { p = await ctx.resolvePathway(caseRow.user_id); } catch (e) { p = null; }
    if (!p || p.readFailed) return { error: fail(503, 'pathway_unreadable', 'This doctor\'s pathway could not be read just now. Please try again.') };
    if (!p.isAu) return { error: fail(409, 'not_au_pathway', 'This doctor is not on an Australian pathway. Commencement tracking is only for Australian placements.') };
    const rows = await placementRowsFor(caseRow.user_id);
    if (rows === null) return { error: fail(502, 'placements_unreadable', 'The placement could not be read. Please try again.') };
    const row = currentRow(rows);
    return { caseRow, pathway: p, rows, row, placement: row ? shapeOf(row) : null };
  }

  async function namesFor(L) {
    let info = null;
    try { info = await ctx.placementContext(L.caseRow.user_id, L.placement); } catch (e) { info = null; }
    info = info || {};
    let consultant = '';
    try { consultant = await ctx.placingConsultant(L.caseRow.id); } catch (e) { consultant = ''; }
    return {
      gpName: info.gpName || '', practiceName: info.practiceName || L.placement.practiceName || '',
      practiceEmail: info.practiceEmail || '', practiceContactName: info.practiceContactName || '',
      placingConsultant: consultant || ''
    };
  }

  function taskStageFor(caseRow, fallback) {
    const s = caseRow && caseRow.stage;
    return journeyLadders.isAuOnlyStage(s) || s === 'complete' ? s : (fallback || null);
  }

  // Every WP-13 task on a case for one placement, metadata parsed.
  async function lifecycleTasks(caseId, placementKey) {
    const out = [];
    for (const type of [lifecycle.TASK_TYPE.INVOICE_DUE, lifecycle.TASK_TYPE.GUARANTEE_CHECKIN, lifecycle.TASK_TYPE.MANUAL]) {
      const read = await ctx.tasksOfType(caseId, type);
      if (!read.ok) return { ok: false, tasks: [] };
      read.tasks.forEach(function (t) {
        if (!t.metadata || !t.metadata.lifecycle_kind) return;
        if (String(t.metadata.placement_key || '') !== String(placementKey)) return;
        out.push(t);
      });
    }
    return { ok: true, tasks: out };
  }

  // ── the fee ────────────────────────────────────────────────────────────────

  function computeFee(pathwayResult, practice, sessions) {
    const variant = fees.signedAgreementVariantFor(practice);
    const fee = fees.placementFeeFor({
      basis: candidatePathway.feeBasisFor(pathwayResult),
      sessionsPerWeek: sessions,
      variant: variant.variant, variantKnown: variant.known, variantReason: variant.reason
    });
    return { fee, variant };
  }
  // The fee as it stands on a row already commenced (used when a missing task
  // is re-created; the stored figures are never recomputed behind staff's back).
  function feeFromRow(row, pathwayResult, practice) {
    const stored = row.fee_amount_ex_gst === null || row.fee_amount_ex_gst === undefined ? null : Number(row.fee_amount_ex_gst);
    if (Number.isFinite(stored) && row.fee_tier && row.agreement_variant) {
      return {
        tier: row.fee_tier, amountExGst: stored, variant: row.agreement_variant, basis: row.candidate_basis || fees.BASIS.AUSTRALIA,
        source: 'agreement', known: true, reason: '', invoiceTiming: fees.INVOICE_TIMING,
        sessionsPerWeek: fees.cleanSessions(row.sessions_per_week_numeric)
      };
    }
    return computeFee(pathwayResult, practice, row.sessions_per_week_numeric).fee;
  }
  function variantLabel(key) {
    return key && agreementVariants.isAgreementVariant(key) ? agreementVariants.getAgreementVariant(key).label : '';
  }

  // ── tasks ──────────────────────────────────────────────────────────────────

  function matcher(kind, placementKey, mark) {
    return function (t) {
      const m = t.metadata || {};
      return m.lifecycle_kind === kind && m.undone !== true
        && String(m.placement_key == null ? '' : m.placement_key) === String(placementKey == null ? '' : placementKey)
        && (mark === undefined || String(m.mark == null ? '' : m.mark) === String(mark || ''));
    };
  }

  /**
   * THE IDEMPOTENCY RULE for every task a placement derives (the invoice
   * task, the check-ins, the first-week task, each lifecycle reminder, the
   * "replacement or credit" task): one per case, placement, kind and mark.
   *
   * It is the DATABASE that guarantees it, not this function: the partial
   * unique index `uniq_au_lifecycle_task` (WP-13 migration) on
   * (case_id, metadata->>'placement_key', metadata->>'lifecycle_kind',
   * metadata->>'mark'), not counting tasks marked `undone`. So this is a
   * plain read, then an insert, and an insert the index refuses (409) means
   * "someone else created it a moment ago": read again and report it as
   * existing. There is no ledger claim to take over and no waiting, so two
   * requests at once (two people pressing, the daily job overlapping a
   * person, two overlapping job runs) can never produce two, however slow
   * either is; and a process that dies half-way leaves nothing to clean up:
   * the next caller simply creates whatever is still missing.
   *
   * @returns {Promise<{ ok: boolean, created: boolean, taskId?: string, reason?: string }>}
   */
  async function ensureTask(caseRow, fields, kind, placementKey, mark, actor) {
    if (!fields) return { ok: false, created: false, reason: 'no_fields' };
    const find = async function () {
      const read = await ctx.tasksOfType(caseRow.id, fields.task_type);
      if (!read.ok) return { ok: false, task: null };
      return { ok: true, task: read.tasks.filter(matcher(kind, placementKey, mark || ''))[0] || null };
    };
    try {
      const before = await find();
      if (!before.ok) return { ok: false, created: false, reason: 'read_failed' };
      if (before.task) return { ok: true, created: false, taskId: before.task.id, reason: 'exists' };
      const made = await ctx.insertTask(caseRow.id, Object.assign({}, fields, { _actor: actor || 'system' }));
      if (made && made.ok && made.task) return { ok: true, created: true, taskId: made.task.id };
      if (made && made.status === 409) {
        const after = await find();
        if (after.ok && after.task) return { ok: true, created: false, taskId: after.task.id, reason: 'exists' };
      }
      return { ok: false, created: false, reason: 'write_failed' };
    } catch (err) {
      return { ok: false, created: false, reason: 'threw' };
    }
  }

  // The five tasks "Confirm commenced" owes a placement. Idempotent and safe
  // to run from several places at once (ensureTask): the request that won the
  // commencement, a second press, and the daily job's repair.
  async function ensureDerivedTasks(L, row, fee, names, actor) {
    const out = { created: [], existing: [], failed: [] };
    const key = L.placement.key;
    const base = {
      name: names.gpName, practiceName: names.practiceName, placementKey: key, applicationId: L.placement.applicationId,
      commencedAt: fees.cleanDay(row.commenced_at), placingConsultant: names.placingConsultant
    };
    const note = function (label, res) {
      if (res && res.created) out.created.push(label);
      else if (res && res.ok) out.existing.push(label);
      else out.failed.push(label);
    };
    note('invoice_due', await ensureTask(L.caseRow,
      lifecycle.buildInvoiceTask(Object.assign({}, base, { fee, variantLabel: variantLabel(fee.variant), stage: 'commenced' })), KIND.INVOICE, key, '', actor));
    for (const week of fees.CHECKIN_WEEKS) {
      note('guarantee_checkin:w' + week, await ensureTask(L.caseRow,
        lifecycle.buildCheckinTask(week, Object.assign({}, base, { stage: 'guarantee' })), KIND.CHECKIN, key, 'w' + week, actor));
    }
    note('week1_checkin', await ensureTask(L.caseRow,
      lifecycle.buildWeek1Task(Object.assign({}, base, { stage: 'commenced' })), KIND.WEEK1, key, 'w1', actor));
    return out;
  }

  async function patchTask(taskId, body) {
    return db('registration_tasks', 'id=eq.' + enc(taskId), { method: 'PATCH', body: Object.assign({}, body, { updated_at: new Date(nowMs()).toISOString() }) });
  }
  async function cancelTask(task, caseId, actor, why, extraMeta) {
    await patchTask(task.id, { status: 'cancelled', metadata: Object.assign({}, task.metadata, extraMeta || {}, { cancelled_reason: why }) });
    await ctx.logCaseEvent(caseId, task.id, 'system', 'Task cancelled: ' + cleanText(task.title, 160), why, actor);
  }

  // Forward along the ladder after commencement: `commenced`, and `guarantee`
  // once the first week is over. THE DECISION: `commenced` is not momentary.
  // It lasts the doctor's first week and the case moves to `guarantee` on the
  // day of the week-1 check-in (the daily job), or at once when commencement
  // is confirmed more than a week late. The guarantee PERIOD itself always
  // runs from the commencement day (placements.guarantee_ends_at): the stage
  // is what staff and the doctor are shown, not what the dates are worked from.
  async function moveStageForCommencement(caseRow, commencedAt, today, actor, why) {
    const out = { commenced: null, guarantee: null };
    out.commenced = await ctx.advanceStage(caseRow.id, 'commenced', actor, { reason: why });
    if (today >= fees.addDays(commencedAt, lifecycle.WEEK1_DAYS)) {
      out.guarantee = await ctx.advanceStage(caseRow.id, 'guarantee', actor, { reason: 'First week complete (commenced ' + commencedAt + ')' });
    }
    return out;
  }

  // ── Confirm commenced (checklist row 12, ADM-06) ───────────────────────────

  /**
   * Record that the doctor actually started. One idempotent sequence:
   *   1 stamp the date and who confirmed it on the placement (compare-and-set:
   *     only a row with no commencement date is written, so two people
   *     pressing the button produce one commencement);
   *   2 work out the fee from the agreement the practice signed and store the
   *     tier, amount, variant and basis (or store no amount when it cannot be
   *     known);
   *   3 the invoice falls due on the commencement day; the guarantee period
   *     ends twelve weeks after it;
   *   4 ONE invoice task for the CEO, THREE check-ins (weeks 4, 8, 12) and the
   *     first-week check-in for the consultant;
   *   5 the case moves prestart -> commenced (-> guarantee after week 1).
   * Running it again with the same date changes nothing and creates nothing.
   *
   * @param {string} caseId
   * @param {{ commenced_at, sessions_per_week?, sessions_unknown?, override?, override_reason? }} body
   * @param {string} actor  staff email
   */
  async function confirmCommencement(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    if (!row) return fail(409, 'no_placement', 'No placement is recorded for this doctor yet. Record the placement first.');
    if (row.status !== 'active') return fail(409, 'placement_not_active', 'This doctor\'s latest placement has ended. Record the new placement first.');
    const practice = await practiceFor(row);
    const today = todayAt(practice);
    const names = await namesFor(L);
    const asked = fees.cleanDay(b.commenced_at);
    const already = fees.cleanDay(row.commenced_at);

    if (already) {
      if (asked && asked !== already) {
        return fail(409, 'already_commenced', 'Commencement is already recorded for this placement (' + lifecycle.longDay(already) + '). To change the date, the CEO uses "Correct commencement details".', { commenced_at: already });
      }
      // The same request again: make sure nothing is missing, change nothing.
      const tasksAgain = await ensureDerivedTasks(L, row, feeFromRow(row, L.pathway, practice), names, actor);
      const stageAgain = await moveStageForCommencement(L.caseRow, already, today, actor, 'Commencement confirmed for ' + already);
      return { ok: true, status: 200, already: true, commenced_at: already, tasks: tasksAgain, stage: stageAgain };
    }

    let pre = { ok: false, complete: false };
    try { pre = await ctx.prestartComplete(L.caseRow.id); } catch (e) { pre = { ok: false, complete: false }; }
    const placedMs = Date.parse(row.placed_at || row.created_at || '');
    const check = lifecycle.validateCommencement({
      commencedAt: b.commenced_at, today,
      placedDay: Number.isFinite(placedMs) ? lifecycle.localDay(placedMs, zoneFor(practice)) : '',
      sessions: b.sessions_per_week, sessionsOnFile: row.sessions_per_week_numeric, sessionsUnknown: b.sessions_unknown === true,
      prestartComplete: pre.ok === true && pre.complete === true, override: b.override === true, overrideReason: b.override_reason
    });
    if (!check.ok) {
      return fail(check.code === 'prestart_incomplete' ? 409 : 400, check.code, check.message, {
        prestart_missing: pre.missing || [], prestart_open: pre.open || [],
        prestart_documents_outstanding: pre.documentsOutstanding || [],
        sessions_suggested: fees.cleanSessions(row.sessions_per_week), today
      });
    }
    const computed = computeFee(L.pathway, practice, check.sessions);
    const fee = computed.fee;
    const patch = {
      commenced_at: check.commencedAt,
      commencement_confirmed_by: actor || 'staff',
      candidate_basis: fee.basis,
      fee_tier: fee.tier,
      fee_amount_ex_gst: fee.known ? fee.amountExGst : null,
      agreement_variant: fee.variant,
      // "For Australian-based GPs, the full fee is invoiced when the placed
      // doctor commences work" (agreement-2026.html:184-185; owner decision 4).
      invoice_due_at: check.commencedAt,
      guarantee_ends_at: fees.guaranteeEndsOn(check.commencedAt),
      sessions_per_week_numeric: check.sessions
    };
    const write = await db('placements', 'id=eq.' + enc(row.id) + '&commenced_at=is.null', {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch
    });
    if (!write.ok) {
      return fail(503, 'placement_write_failed', 'The commencement could not be saved. If this database does not have the WP-13 columns yet, the migration needs applying first.');
    }
    if (!Array.isArray(write.data) || !write.data.length) {
      // Someone else confirmed it a moment ago. Answer as the second caller.
      const again = await load(caseId);
      if (again.error || !again.row || !fees.cleanDay(again.row.commenced_at)) return fail(409, 'commencement_conflict', 'The placement changed while this was being saved. Please reload and try again.');
      return confirmCommencement(caseId, { commenced_at: fees.cleanDay(again.row.commenced_at) }, actor);
    }
    const saved = write.data[0];
    L.row = saved;
    L.placement = shapeOf(saved);

    await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Commencement confirmed: ' + check.commencedAt,
      'Confirmed by ' + (actor || 'staff') + '. Sessions a week: ' + (check.sessions === null ? 'not known yet' : check.sessions)
      + '. Guarantee period ends ' + patch.guarantee_ends_at + '. '
      + (check.overridden ? 'The pre-start checklist was NOT complete; confirmed anyway. Reason given: ' + check.overrideReason : 'The pre-start checklist was complete.'),
      actor || 'staff', { au: true, placement_key: L.placement.key, commenced_at: check.commencedAt, prestart_override: check.overridden });

    const tasks = await ensureDerivedTasks(L, saved, fee, names, actor);

    // The reminders from before the start have been answered by the fact that
    // the doctor has started: the "start date reached" prompt, "has the doctor
    // given notice?" and "start date close, pre-start not finished".
    try {
      const answered = [KIND.START_REACHED, KIND.NOTICE, KIND.PRESTART_AT_RISK];
      const lc = await lifecycleTasks(L.caseRow.id, L.placement.key);
      for (const t of lc.tasks.filter(function (x) { return answered.indexOf(x.metadata.lifecycle_kind) !== -1 && isOpenTask(x); })) {
        await ctx.completeTask(t.id, L.caseRow.id, actor || 'system');
      }
    } catch (e) { /* the prompt can be closed by hand */ }

    const stage = await moveStageForCommencement(L.caseRow, check.commencedAt, today, actor, 'Commencement confirmed for ' + check.commencedAt + ' by ' + (actor || 'staff'));
    ctx.invalidate();
    return {
      ok: true, status: 200, already: false, commenced_at: check.commencedAt, guarantee_ends_at: patch.guarantee_ends_at,
      invoice_due_at: patch.invoice_due_at, sessions_per_week: check.sessions, prestart_override: check.overridden,
      fee: { known: fee.known, tier: fee.tier, amount_ex_gst: fee.known ? fee.amountExGst : null, variant: fee.variant, basis: fee.basis, reason: fee.known ? null : fee.reason },
      tasks, stage
    };
  }

  // ── Correct commencement details (CEO only) ────────────────────────────────

  /**
   * The date (or the sessions a week) was recorded wrongly. Re-dates what was
   * derived from it: the invoice due date, the guarantee end date and every
   * derived task that is still open. A completed task is left as it is. The
   * stage is not moved (the ladder only goes forward).
   */
  async function correctCommencement(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const was = row ? fees.cleanDay(row.commenced_at) : '';
    if (!row || !was) return fail(409, 'not_commenced', 'Commencement has not been confirmed for this placement.');
    if (fees.cleanDay(row.ended_at)) return fail(409, 'placement_ended', 'This placement has ended. Its commencement details can no longer be changed here.');
    const reason = cleanText(b.reason, 500);
    if (reason.length < REASON_MIN) return fail(400, 'reason_required', 'Please say why this is being corrected (at least ' + REASON_MIN + ' characters).');
    const practice = await practiceFor(row);
    const today = todayAt(practice);
    const newDay = b.commenced_at === undefined || b.commenced_at === null || b.commenced_at === '' ? was : fees.cleanDay(b.commenced_at);
    if (!newDay) return fail(400, 'invalid_date', 'Please give the date as YYYY-MM-DD.');
    if (newDay > today) return fail(400, 'date_in_future', 'That date is in the future at the practice (today there is ' + lifecycle.longDay(today) + ').');
    const placedMs = Date.parse(row.placed_at || row.created_at || '');
    const placedDay = Number.isFinite(placedMs) ? lifecycle.localDay(placedMs, zoneFor(practice)) : '';
    if (placedDay && newDay < placedDay) return fail(400, 'date_before_placement', 'That date is before the placement was recorded (' + lifecycle.longDay(placedDay) + ').');
    const sessionsGiven = b.sessions_per_week !== undefined && b.sessions_per_week !== null && String(b.sessions_per_week).trim() !== '';
    let sessions = fees.cleanSessions(row.sessions_per_week_numeric);
    if (sessionsGiven) {
      sessions = fees.cleanSessions(b.sessions_per_week);
      if (sessions === null) return fail(400, 'invalid_sessions', 'Sessions a week must be a number between 0.5 and ' + fees.MAX_SESSIONS + '.');
      if (fees.cleanDay(row.invoice_sent_at) && sessions !== fees.cleanSessions(row.sessions_per_week_numeric)) {
        return fail(409, 'invoice_already_sent', 'An invoice is recorded as sent for this placement, so the sessions (and with them the fee tier) cannot be changed here. Clear the "invoice sent" record first if it was wrong.');
      }
    }
    const dateChanged = newDay !== was;
    const sessionsChanged = sessions !== fees.cleanSessions(row.sessions_per_week_numeric);
    if (!dateChanged && !sessionsChanged) return fail(400, 'nothing_to_change', 'Nothing was changed: the date and the sessions are the same as on file.');

    const patch = {};
    if (dateChanged) {
      patch.commenced_at = newDay;
      patch.invoice_due_at = newDay;
      patch.guarantee_ends_at = fees.guaranteeEndsOn(newDay);
    }
    let fee = feeFromRow(row, L.pathway, practice);
    if (sessionsChanged || !fee.known) {
      fee = computeFee(L.pathway, practice, sessions).fee;
      patch.sessions_per_week_numeric = sessions;
      patch.candidate_basis = fee.basis;
      patch.fee_tier = fee.tier;
      patch.fee_amount_ex_gst = fee.known ? fee.amountExGst : null;
      patch.agreement_variant = fee.variant;
    }
    // Compare-and-set on the date AND the sessions this request read: the same
    // correction submitted twice at once is applied (and logged) once.
    const sessionsWas = fees.cleanSessions(row.sessions_per_week_numeric);
    const write = await db('placements', 'id=eq.' + enc(row.id) + '&commenced_at=eq.' + enc(was)
      + '&sessions_per_week_numeric=' + (sessionsWas === null ? 'is.null' : 'eq.' + enc(sessionsWas)), {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch
    });
    if (!write.ok) return fail(502, 'placement_write_failed', 'The correction could not be saved. Please reload and try again.');
    if (!Array.isArray(write.data) || !write.data.length) return fail(409, 'commencement_conflict', 'These details have just been changed by someone else. Please reload and check before correcting again.');
    const saved = write.data[0];
    L.row = saved;
    L.placement = shapeOf(saved);
    const names = await namesFor(L);

    // Re-date the derived tasks that are still open.
    const redated = [];
    const lc = await lifecycleTasks(L.caseRow.id, L.placement.key);
    const base = {
      name: names.gpName, practiceName: names.practiceName, placementKey: L.placement.key, applicationId: L.placement.applicationId,
      commencedAt: newDay, placingConsultant: names.placingConsultant
    };
    for (const t of lc.tasks) {
      if (!isOpenTask(t) || t.metadata.undone === true) continue;
      let fresh = null;
      if (t.metadata.lifecycle_kind === KIND.INVOICE) fresh = lifecycle.buildInvoiceTask(Object.assign({}, base, { fee, variantLabel: variantLabel(fee.variant) }));
      else if (t.metadata.lifecycle_kind === KIND.CHECKIN) fresh = lifecycle.buildCheckinTask(Number(t.metadata.week), base);
      else if (t.metadata.lifecycle_kind === KIND.WEEK1) fresh = lifecycle.buildWeek1Task(base);
      if (!fresh) continue;
      await patchTask(t.id, {
        title: fresh.title, description: fresh.description, due_date: fresh.due_date,
        metadata: Object.assign({}, t.metadata, fresh.metadata, { corrected_at: new Date(nowMs()).toISOString(), corrected_by: actor || 'staff' })
      });
      redated.push(t.metadata.lifecycle_kind + (t.metadata.mark ? ':' + t.metadata.mark : ''));
    }
    await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Commencement details corrected',
      (dateChanged ? 'Commencement date ' + was + ' -> ' + newDay + ' (guarantee period now ends ' + patch.guarantee_ends_at + '). ' : '')
      + (sessionsChanged ? 'Sessions a week ' + (fees.cleanSessions(row.sessions_per_week_numeric) === null ? 'not known' : row.sessions_per_week_numeric) + ' -> ' + sessions + '. ' : '')
      + 'Reason: ' + reason + '. Open tasks re-dated: ' + (redated.join(', ') || 'none') + '.',
      actor || 'staff', { au: true, placement_key: L.placement.key, correction: true });
    ctx.invalidate();
    return {
      ok: true, status: 200, commenced_at: newDay, previous_commenced_at: was, guarantee_ends_at: fees.cleanDay(saved.guarantee_ends_at),
      sessions_per_week: sessions, redated,
      fee: { known: fee.known, tier: fee.tier, amount_ex_gst: fee.known ? fee.amountExGst : null, variant: fee.variant, reason: fee.known ? null : fee.reason }
    };
  }

  // ── Commencement recorded in error (CEO only) ──────────────────────────────

  /**
   * THE UNDO RULE. Commencement was recorded against the wrong doctor, or the
   * doctor did not start after all. This clears the commencement from the
   * placement, cancels the tasks it created, and returns the case to
   * `prestart` through the one deliberate, audited backward move the ladder
   * allows (advanceAuCaseStage's `undoCommencement`).
   *
   * Refused when it would lose something real: an invoice recorded as sent
   * (clear that record first), a placement that has ended, a case already
   * complete. Messages already sent (N18 / N19) cannot be unsent and are not
   * sent again if commencement is confirmed again for the same placement.
   */
  async function undoCommencement(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const was = row ? fees.cleanDay(row.commenced_at) : '';
    if (!row || !was) return fail(409, 'not_commenced', 'Commencement has not been confirmed for this placement.');
    const reason = cleanText(b.reason, 500);
    if (reason.length < REASON_MIN) return fail(400, 'reason_required', 'Please say why this commencement was recorded in error (at least ' + REASON_MIN + ' characters).');
    if (fees.cleanDay(row.ended_at)) return fail(409, 'placement_ended', 'This placement has ended, so its commencement cannot be undone.');
    if (fees.cleanDay(row.invoice_sent_at)) return fail(409, 'invoice_already_sent', 'An invoice is recorded as sent for this placement. If that record is wrong, clear it first; if a real invoice went out, deal with it by hand before undoing the commencement.');
    if (L.caseRow.stage === 'complete') return fail(409, 'case_complete', 'This case is already complete. Its commencement cannot be undone.');

    const write = await db('placements', 'id=eq.' + enc(row.id) + '&commenced_at=eq.' + enc(was), {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: {
        commenced_at: null, commencement_confirmed_by: null, candidate_basis: null, fee_tier: null, fee_amount_ex_gst: null,
        agreement_variant: null, invoice_due_at: null, guarantee_ends_at: null
      }
    });
    if (!write.ok) return fail(502, 'placement_write_failed', 'The commencement could not be undone. Please reload and try again.');
    // Compare-and-set on the date we read: of two people undoing at once, one
    // does the work and the other is told it is already done.
    if (!Array.isArray(write.data) || !write.data.length) return fail(409, 'not_commenced', 'This commencement has just been changed or removed by someone else. Please reload.');

    const key = L.placement.key;
    const cancelled = [];
    const lc = await lifecycleTasks(L.caseRow.id, key);
    const postKinds = lifecycle.COMMENCEMENT_DERIVED_KINDS.concat([KIND.GUARANTEE_ENDING, KIND.UPLIFT, KIND.INVOICE_OVERDUE]);
    for (const t of lc.tasks) {
      if (postKinds.indexOf(t.metadata.lifecycle_kind) === -1 || t.metadata.undone === true) continue;
      if (isOpenTask(t)) {
        await cancelTask(t, L.caseRow.id, actor || 'staff', 'Commencement recorded in error', { undone: true });
        cancelled.push(t.metadata.lifecycle_kind + (t.metadata.mark ? ':' + t.metadata.mark : ''));
      } else {
        await patchTask(t.id, { metadata: Object.assign({}, t.metadata, { undone: true }) });
      }
    }
    // Every task of this commencement now carries `undone`, which takes it out
    // of the unique index (and out of every "is it there?" read), so a later,
    // correct commencement creates a fresh set. The MESSAGE ledger keys are
    // kept on purpose: nobody is written to twice about the same placement.
    const stage = await ctx.advanceStage(L.caseRow.id, 'prestart', actor, { undoCommencement: true, reason: 'Commencement recorded in error: ' + reason });
    await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Commencement recorded in error: undone',
      'The commencement of ' + was + ' was removed by ' + (actor || 'staff') + '. Reason: ' + reason + '. Tasks cancelled: ' + (cancelled.join(', ') || 'none') + '.',
      actor || 'staff', { au: true, placement_key: key, undo_commencement: true, previous_commenced_at: was });
    ctx.invalidate();
    return { ok: true, status: 200, undone: true, previous_commenced_at: was, cancelled, stage };
  }

  // ── Invoice tracking (CEO only). Nothing here talks to Xero. ───────────────

  async function markInvoiceSent(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const commenced = row ? fees.cleanDay(row.commenced_at) : '';
    if (!row || !commenced) return fail(409, 'not_commenced', 'Commencement has not been confirmed for this placement, so no invoice is due yet.');
    const key = L.placement.key;
    const lc = await lifecycleTasks(L.caseRow.id, key);
    const invoiceTasks = lc.tasks.filter(function (t) { return t.metadata.lifecycle_kind === KIND.INVOICE && t.metadata.undone !== true; });

    if (b.clear === true) {
      // A "sent" recorded by mistake. Never a way to hide a real invoice: the
      // reason is logged and a paid invoice cannot be cleared.
      const why = cleanText(b.reason, 500);
      if (why.length < REASON_MIN) return fail(400, 'reason_required', 'Please say why the "invoice sent" record is being cleared (at least ' + REASON_MIN + ' characters).');
      if (!fees.cleanDay(row.invoice_sent_at)) return fail(409, 'invoice_not_sent', 'No invoice is recorded as sent.');
      if (fees.cleanDay(row.invoice_paid_at)) return fail(409, 'invoice_already_paid', 'This invoice is recorded as paid. Clear the payment first.');
      const cleared = await db('placements', 'id=eq.' + enc(row.id) + '&invoice_sent_at=eq.' + enc(fees.cleanDay(row.invoice_sent_at)) + '&invoice_paid_at=is.null',
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { invoice_sent_at: null, invoice_reference: null } });
      if (!cleared.ok) return fail(502, 'placement_write_failed', 'That could not be saved. Please try again.');
      if (!Array.isArray(cleared.data) || !cleared.data.length) return fail(409, 'invoice_conflict', 'The invoice record has just been changed by someone else. Please reload and check.');
      for (const t of invoiceTasks.filter(function (x) { return x.status === 'completed'; })) await patchTask(t.id, { status: 'open', completed_at: null, completed_by: null });
      await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Invoice "sent" record cleared', 'Cleared by ' + (actor || 'staff') + '. Reason: ' + why, actor || 'staff', { au: true, placement_key: key });
      ctx.invalidate();
      return { ok: true, status: 200, cleared: true };
    }

    const practice = await practiceFor(row);
    const today = todayAt(practice);
    const sentDay = fees.cleanDay(b.sent_at);
    if (!sentDay) return fail(400, 'invalid_date', 'Please give the date the invoice was sent (YYYY-MM-DD).');
    if (sentDay > today) return fail(400, 'date_in_future', 'That date is in the future.');
    if (sentDay < commenced) return fail(400, 'date_before_commencement', 'The invoice is raised on commencement (' + lifecycle.longDay(commenced) + '), so it cannot have been sent before that.');
    const reference = cleanText(b.reference, 60);
    if (!reference) return fail(400, 'reference_required', 'Please enter the invoice number.');
    const patch = { invoice_sent_at: sentDay, invoice_reference: reference };
    // A fee the app could not work out: the amount a person invoiced may be
    // recorded by hand. It is their figure, stored as typed, never computed.
    const storedAmount = row.fee_amount_ex_gst === null || row.fee_amount_ex_gst === undefined ? null : Number(row.fee_amount_ex_gst);
    let amountByHand = null;
    if (b.amount_ex_gst !== undefined && b.amount_ex_gst !== null && String(b.amount_ex_gst).trim() !== '') {
      const n = Number(String(b.amount_ex_gst).replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n) || n <= 0 || n > 1000000) return fail(400, 'invalid_amount', 'The amount must be a number of dollars, exclusive of GST.');
      if (storedAmount !== null && n !== storedAmount) return fail(409, 'amount_differs_from_agreement', 'The fee for this placement is already on file from the agreement. To invoice a different amount, correct the sessions a week first.');
      if (storedAmount === null) { amountByHand = n; patch.fee_amount_ex_gst = n; }
    }
    const same = fees.cleanDay(row.invoice_sent_at) === sentDay && String(row.invoice_reference || '') === reference && amountByHand === null;
    if (!same) {
      // Compare-and-set on what this request read (not sent yet, or the
      // earlier date): a double submit records and logs the invoice once.
      const sentWas = fees.cleanDay(row.invoice_sent_at);
      const write = await db('placements', 'id=eq.' + enc(row.id) + '&invoice_sent_at=' + (sentWas ? 'eq.' + enc(sentWas) : 'is.null'),
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
      if (!write.ok) return fail(502, 'placement_write_failed', 'That could not be saved. Please try again.');
      if (!Array.isArray(write.data) || !write.data.length) {
        const again = await load(caseId);
        const now = again.row || {};
        if (!again.error && fees.cleanDay(now.invoice_sent_at) === sentDay && String(now.invoice_reference || '') === reference) {
          return { ok: true, status: 200, invoice_sent_at: sentDay, invoice_reference: reference, payment_due_by: fees.invoicePaymentDueOn(sentDay), task_closed: false, unchanged: true };
        }
        return fail(409, 'invoice_conflict', 'The invoice record has just been changed by someone else. Please reload and check.');
      }
      await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Placement-fee invoice sent: ' + reference,
        'Sent ' + sentDay + ', recorded by ' + (actor || 'staff') + '. Payment is due within seven days of the invoice date (' + fees.invoicePaymentDueOn(sentDay) + ').'
        + (amountByHand !== null ? ' The invoiced amount was entered by hand (the app could not work the fee out).' : ''),
        actor || 'staff', { au: true, placement_key: key, invoice_reference: reference });
    }
    const closed = [];
    for (const t of invoiceTasks.filter(isOpenTask)) { await ctx.completeTask(t.id, L.caseRow.id, actor || 'staff'); closed.push(t.id); }
    ctx.invalidate();
    return { ok: true, status: 200, invoice_sent_at: sentDay, invoice_reference: reference, payment_due_by: fees.invoicePaymentDueOn(sentDay), task_closed: closed.length > 0, unchanged: same };
  }

  async function markInvoicePaid(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const sent = row ? fees.cleanDay(row.invoice_sent_at) : '';
    if (!row || !sent) return fail(409, 'invoice_not_sent', 'Record the invoice as sent before marking it paid.');
    const key = L.placement.key;
    if (b.clear === true) {
      const why = cleanText(b.reason, 500);
      if (why.length < REASON_MIN) return fail(400, 'reason_required', 'Please say why the payment record is being cleared (at least ' + REASON_MIN + ' characters).');
      if (!fees.cleanDay(row.invoice_paid_at)) return fail(409, 'invoice_not_paid', 'No payment is recorded.');
      const cleared = await db('placements', 'id=eq.' + enc(row.id) + '&invoice_paid_at=eq.' + enc(fees.cleanDay(row.invoice_paid_at)),
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { invoice_paid_at: null } });
      if (!cleared.ok) return fail(502, 'placement_write_failed', 'That could not be saved. Please try again.');
      if (!Array.isArray(cleared.data) || !cleared.data.length) return fail(409, 'invoice_conflict', 'The payment record has just been changed by someone else. Please reload and check.');
      await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Invoice payment record cleared', 'Cleared by ' + (actor || 'staff') + '. Reason: ' + why, actor || 'staff', { au: true, placement_key: key });
      ctx.invalidate();
      return { ok: true, status: 200, cleared: true };
    }
    const practice = await practiceFor(row);
    const today = todayAt(practice);
    const paidDay = fees.cleanDay(b.paid_at);
    if (!paidDay) return fail(400, 'invalid_date', 'Please give the date the invoice was paid (YYYY-MM-DD).');
    if (paidDay > today) return fail(400, 'date_in_future', 'That date is in the future.');
    if (paidDay < sent) return fail(400, 'date_before_invoice', 'The invoice was sent on ' + lifecycle.longDay(sent) + ', so it cannot have been paid before that.');
    const dueBy = fees.invoicePaymentDueOn(sent);
    const same = fees.cleanDay(row.invoice_paid_at) === paidDay;
    if (!same) {
      // Compare-and-set, as for "sent": one payment record, one timeline line.
      const paidWas = fees.cleanDay(row.invoice_paid_at);
      const write = await db('placements', 'id=eq.' + enc(row.id) + '&invoice_sent_at=eq.' + enc(sent) + '&invoice_paid_at=' + (paidWas ? 'eq.' + enc(paidWas) : 'is.null'),
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { invoice_paid_at: paidDay } });
      if (!write.ok) return fail(502, 'placement_write_failed', 'That could not be saved. Please try again.');
      if (!Array.isArray(write.data) || !write.data.length) {
        const again = await load(caseId);
        if (!again.error && again.row && fees.cleanDay(again.row.invoice_paid_at) === paidDay) {
          return { ok: true, status: 200, invoice_paid_at: paidDay, payment_due_by: dueBy, paid_late: paidDay > dueBy, unchanged: true };
        }
        return fail(409, 'invoice_conflict', 'The invoice record has just been changed by someone else. Please reload and check.');
      }
      await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Placement-fee invoice paid',
        'Paid ' + paidDay + ' (due by ' + dueBy + '), recorded by ' + (actor || 'staff') + '.' + (paidDay > dueBy ? ' This is after the due date.' : ''),
        actor || 'staff', { au: true, placement_key: key, paid_late: paidDay > dueBy });
      const lc = await lifecycleTasks(L.caseRow.id, key);
      for (const t of lc.tasks.filter(function (x) { return x.metadata.lifecycle_kind === KIND.INVOICE_OVERDUE && isOpenTask(x); })) {
        await ctx.completeTask(t.id, L.caseRow.id, actor || 'staff');
      }
    }
    ctx.invalidate();
    return { ok: true, status: 200, invoice_paid_at: paidDay, payment_due_by: dueBy, paid_late: paidDay > dueBy, unchanged: same };
  }

  // ── Early exit (checklist row 15; commercial issue 5) ──────────────────────

  /**
   * "The doctor left." Records the last working day and the reason, works out
   * the credit from the agreement's schedule WHEN EVERY CONDITION CAN BE
   * CHECKED (otherwise stores none and asks the CEO to decide), cancels the
   * check-ins still to come, raises the CEO's "replacement or credit" task,
   * marks the placement ended (which is what lets the doctor look for a role
   * again: WP-08's re-entry rule reads `ended_at`), and completes the case.
   *
   * @param {{ last_working_day, reason, note?, conditions_confirmed?: 'yes'|'no'|'unknown' }} body
   *
   * FB-2b (W3-D15): this is the action for a doctor who left DURING the
   * guarantee period. Which action is right is decided by the LAST WORKING
   * DAY, never by the day it is typed in: a last working day after the
   * guarantee period ended is refused here (409 `after_guarantee_period`) and
   * belongs to `recordPlacementEnded`, which asks no credit question.
   */
  async function recordEarlyExit(caseId, body, actor, mode) {
    const afterGuarantee = mode === 'after_guarantee';
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const commenced = row ? fees.cleanDay(row.commenced_at) : '';
    if (!row || !commenced) return fail(409, 'not_commenced', 'Commencement has not been confirmed for this placement. If the doctor will not start at all, that is a withdrawn placement, not an early exit.');
    const lastDay = fees.cleanDay(b.last_working_day);
    const reasonCode = fees.EXIT_REASONS.indexOf(String(b.reason || '')) !== -1 ? String(b.reason) : '';
    const endedAlready = fees.cleanDay(row.ended_at);
    if (endedAlready) {
      if (!lastDay || lastDay === endedAlready) return { ok: true, status: 200, already: true, ended_at: endedAlready, credit_pct: row.credit_pct === null || row.credit_pct === undefined ? null : Number(row.credit_pct) };
      return fail(409, 'already_ended', 'This placement is already recorded as ended on ' + lifecycle.longDay(endedAlready) + '.');
    }
    if (!lastDay) return fail(400, 'invalid_date', 'Please give the doctor\'s last working day (YYYY-MM-DD).');
    if (!reasonCode) return fail(400, 'reason_required', 'Please choose why the doctor left.');
    const practice = await practiceFor(row);
    const today = todayAt(practice);
    if (lastDay > today) {
      // FR-1 (R-09): a last working day still to come is "notice given".
      return Object.assign(fail(400, 'date_in_future', 'That last working day has not arrived yet. To record that the doctor has given notice, use "Notice given": it pauses the check-in messages now, and the exit is recorded on the last working day. The agreement works the credit out from the last working day, not from the day notice is given.'),
        { use: 'notice' });
    }
    if (lastDay < commenced) return fail(400, 'date_before_commencement', 'The last working day cannot be before the commencement date (' + lifecycle.longDay(commenced) + ').');
    // FB-2b (W3-D15): the two actions are told apart by the last working day.
    const guaranteeEnd = fees.cleanDay(String(row.guarantee_ends_at || '')) || fees.guaranteeEndsOn(commenced);
    if (!afterGuarantee && guaranteeEnd && lastDay > guaranteeEnd) {
      return Object.assign(fail(409, 'after_guarantee_period',
        'The guarantee period for this placement ended on ' + lifecycle.longDay(guaranteeEnd) + ', and that last working day is after it. Record it with "Placement ended" instead: no credit applies after the guarantee period.'),
      { use: 'placement-ended', guarantee_ends_at: guaranteeEnd });
    }
    if (afterGuarantee && guaranteeEnd && lastDay <= guaranteeEnd) {
      return Object.assign(fail(409, 'within_guarantee_period',
        'That last working day is inside the guarantee period, which ran until ' + lifecycle.longDay(guaranteeEnd) + '. Record it with "Doctor left during the guarantee" so the credit is worked out from the agreement.'),
      { use: 'early-exit', guarantee_ends_at: guaranteeEnd });
    }
    const conditions = afterGuarantee ? 'unknown'
      : (['yes', 'no', 'unknown'].indexOf(String(b.conditions_confirmed || '')) !== -1 ? String(b.conditions_confirmed) : 'unknown');
    const note = cleanText(b.note, 400);
    const credit = fees.guaranteeCreditFor({
      commencedAt: commenced, lastWorkingDay: lastDay, reason: reasonCode,
      invoiceSentAt: row.invoice_sent_at, invoicePaidAt: row.invoice_paid_at, conditionsConfirmed: conditions, asOf: today
    });
    const write = await db('placements', 'id=eq.' + enc(row.id) + '&ended_at=is.null', {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: {
        ended_at: lastDay,
        end_reason: reasonCode + (note ? ': ' + note : ''),
        credit_pct: credit.known ? credit.creditPct : null,
        // `status` already means this on the live table ('active' | 'ended' | 'cancelled').
        status: 'ended'
      }
    });
    if (!write.ok) return fail(502, 'placement_write_failed', 'That could not be saved. Please try again.');
    if (!Array.isArray(write.data) || !write.data.length) {
      // Someone else recorded the exit a moment ago. Only that request cancels
      // the check-ins, raises the CEO's task and writes the timeline; this one
      // just reports what is now on file.
      const again = await load(caseId);
      const endedNow = again.error || !again.row ? '' : fees.cleanDay(again.row.ended_at);
      if (endedNow && endedNow === lastDay) {
        return { ok: true, status: 200, already: true, ended_at: endedNow, credit_pct: again.row.credit_pct === null || again.row.credit_pct === undefined ? null : Number(again.row.credit_pct) };
      }
      return fail(409, 'already_ended', 'This placement was just recorded as ended by someone else' + (endedNow ? ' (' + lifecycle.longDay(endedNow) + ')' : '') + '. Please reload.');
    }

    const key = L.placement.key;
    const names = await namesFor(L);
    const cancelled = [];
    const lc = await lifecycleTasks(L.caseRow.id, key);
    for (const t of lc.tasks) {
      if (lifecycle.EXIT_CANCELLED_KINDS.indexOf(t.metadata.lifecycle_kind) === -1 || !isOpenTask(t)) continue;
      await cancelTask(t, L.caseRow.id, actor || 'staff', 'The doctor left: last working day ' + lastDay);
      cancelled.push(t.metadata.lifecycle_kind + (t.metadata.mark ? ':' + t.metadata.mark : ''));
    }
    // FR-1 (R-09): a notice on file is now the exit itself.
    for (const t of lc.tasks) {
      if (t.metadata.lifecycle_kind !== KIND.EXIT_NOTICE || !isOpenTask(t)) continue;
      await patchTask(t.id, { status: 'completed', completed_at: new Date(nowMs()).toISOString(), metadata: Object.assign({}, t.metadata, { became_exit_on: lastDay, undone: true }) });
    }
    // FB-2a (W3-D19): a placement that filled its role's last seat left the
    // role marked "filled", and nothing ever reopens it (filling and reopening
    // a role are plain staff edits; a multi-seat role stays open on purpose).
    // Whether the practice wants a replacement is the decision this task is
    // for, so the task says when the role would need reopening.
    let exitRoleStatus = '';
    try { if (ctx.roleStatus && row.career_role_id) exitRoleStatus = String(await ctx.roleStatus(row.career_role_id) || ''); } catch (e) { exitRoleStatus = ''; }
    const exitTask = await ensureTask(L.caseRow, lifecycle.buildExitTask({
      roleStatus: exitRoleStatus,
      name: names.gpName, practiceName: names.practiceName, placementKey: key, applicationId: L.placement.applicationId,
      commencedAt: commenced, lastWorkingDay: lastDay, reason: reasonCode, note, credit, today,
      placingConsultant: names.placingConsultant, stage: taskStageFor(L.caseRow, 'guarantee')
    }), KIND.REPLACEMENT_OR_CREDIT, key, '', actor);

    await ctx.logCaseEvent(L.caseRow.id, null, 'system', (afterGuarantee ? 'Placement ended (after the guarantee period): last working day ' : 'Doctor left: last working day ') + lastDay,
      'Recorded by ' + (actor || 'staff') + '. Reason: ' + (fees.EXIT_REASON_LABEL[reasonCode] || reasonCode) + (note ? ' (' + note + ')' : '') + '. '
      + (afterGuarantee ? 'The guarantee period had ended (' + guaranteeEnd + '): no credit applies and none was asked about.'
        : credit.known ? 'Guarantee credit recorded from the agreement\'s schedule and conditions: ' + credit.creditPct + '% (' + credit.reason + ').' : 'Guarantee credit NOT recorded: a person must decide (' + (credit.needsDecision || []).join(', ') + ').')
      + ' Check-ins cancelled: ' + (cancelled.join(', ') || 'none') + '.',
      actor || 'staff', { au: true, placement_key: key, ended_at: lastDay, credit_known: credit.known, after_guarantee: afterGuarantee });
    const stage = await ctx.advanceStage(L.caseRow.id, 'complete', actor, { reason: 'Placement ended: the doctor\'s last working day was ' + lastDay });
    ctx.invalidate();
    return {
      ok: true, status: 200, already: false, ended_at: lastDay, end_reason: reasonCode, after_guarantee: afterGuarantee,
      credit: { known: credit.known, credit_pct: credit.known ? credit.creditPct : null, reason: credit.reason, needs_decision: credit.needsDecision, schedule_band_pct: credit.scheduleBandPct, days_worked: credit.daysWorked },
      cancelled, exit_task: { ok: !!(exitTask && exitTask.ok), created: !!(exitTask && exitTask.created), id: exitTask && exitTask.taskId }, stage
    };
  }

  /**
   * FR-1 (final review R-09): "Notice given". The doctor has resigned (or been
   * given notice) and the last working day is still to come.
   *   - recorded as one open task on the placement (lifecycle kind
   *     `exit_notice_given`: last working day, reason, note, who recorded it);
   *   - from that moment the daily job sends no check-in (N18, N19) and no
   *     thank-you (N20) to the doctor or the practice for this placement;
   *   - on the last working day (the practice's own calendar date) the daily
   *     job records the exit through recordEarlyExit / recordPlacementEnded,
   *     so the credit rules are exactly the ones already built. Staff can
   *     record it themselves that day with "Doctor left".
   *   - `{ clear: true, reason }` withdraws it (the doctor is staying).
   * A last working day that has already arrived is refused (409
   * `date_reached`): that is "Doctor left", as today.
   * @param {{ last_working_day, reason, note? } | { clear: true, reason }} body
   */
  async function recordExitNotice(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const commenced = row ? fees.cleanDay(row.commenced_at) : '';
    if (!row || !commenced) return fail(409, 'not_commenced', 'Commencement has not been confirmed for this placement, so there is no notice to record here. If the doctor will not start at all, that is a withdrawn placement.');
    if (fees.cleanDay(row.ended_at)) return fail(409, 'already_ended', 'This placement is already recorded as ended on ' + lifecycle.longDay(fees.cleanDay(row.ended_at)) + '.');
    const key = L.placement.key;
    const lc = await lifecycleTasks(L.caseRow.id, key);
    if (!lc.ok) return fail(502, 'tasks_unreadable', 'That could not be saved. Please try again.');
    const existing = lifecycle.exitNoticeFrom(lc.tasks, key);
    if (b.clear === true) {
      const why = cleanText(b.reason, 400);
      if (!why) return fail(400, 'reason_required', 'Please say why the notice is being withdrawn.');
      if (!existing) return { ok: true, status: 200, cleared: true, already: true, notice: null };
      await cancelTask(existing.task, L.caseRow.id, actor || 'staff', 'Notice withdrawn: ' + why, { undone: true, withdrawn_by: actor || 'staff' });
      await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Notice withdrawn: the doctor is staying',
        'Withdrawn by ' + (actor || 'staff') + '. ' + why + ' The check-in messages resume.', actor || 'staff', { au: true, placement_key: key });
      ctx.invalidate();
      return { ok: true, status: 200, cleared: true, notice: null };
    }
    const lastDay = fees.cleanDay(b.last_working_day);
    const reasonCode = fees.EXIT_REASONS.indexOf(String(b.reason || '')) !== -1 ? String(b.reason) : '';
    if (!lastDay) return fail(400, 'invalid_date', 'Please give the doctor\'s last working day (YYYY-MM-DD).');
    if (!reasonCode) return fail(400, 'reason_required', 'Please choose why the doctor is leaving.');
    if (lastDay < commenced) return fail(400, 'date_before_commencement', 'The last working day cannot be before the commencement date (' + lifecycle.longDay(commenced) + ').');
    const practice = await practiceFor(row);
    const today = todayAt(practice);
    if (lastDay <= today) {
      return Object.assign(fail(409, 'date_reached', 'That last working day has already arrived at the practice. Record it with "Doctor left" (or "Placement ended" after the guarantee period) so the credit is worked out now.'),
        { use: 'early-exit' });
    }
    // FR-2 (R2-03): not further ahead than the horizon (a 2099 date was accepted).
    const latest = fees.addDays(today, lifecycle.DATE_HORIZON.LAST_WORKING_DAY_MAX_DAYS_AHEAD);
    if (latest && lastDay > latest) {
      return Object.assign(fail(400, 'date_too_far_ahead', 'That last working day (' + lifecycle.longDay(lastDay) + ') is more than a year away. Check the year.'), { latest });
    }
    const note = cleanText(b.note, 400);
    const names = await namesFor(L);
    // FR-2 (R2-03): a notice task that was closed some other way (before the
    // general task screens refused it) must not block a new notice: the
    // one-per-placement rule only counts a task that is not marked undone.
    for (const stale of lc.tasks) {
      if (stale.metadata.lifecycle_kind !== KIND.EXIT_NOTICE || stale.metadata.undone === true || isOpenTask(stale)) continue;
      await patchTask(stale.id, { metadata: Object.assign({}, stale.metadata, { undone: true, superseded_by_new_notice: true }) });
    }
    const fields = lifecycle.buildExitNoticeTask({
      name: names.gpName, practiceName: names.practiceName, placementKey: key, applicationId: L.placement.applicationId,
      lastWorkingDay: lastDay, reason: reasonCode, note, recordedBy: actor || 'staff', recordedAt: new Date(nowMs()).toISOString(),
      placingConsultant: names.placingConsultant, stage: taskStageFor(L.caseRow, 'guarantee')
    });
    let taskId = null;
    let changed = false;
    if (existing) {
      if (existing.lastWorkingDay === lastDay && existing.reason === reasonCode && (existing.note || '') === (note || '')) {
        return { ok: true, status: 200, already: true, notice: { last_working_day: lastDay, reason: reasonCode, note: note || '', recorded_by: existing.recordedBy, recorded_at: existing.recordedAt } };
      }
      const upd = await patchTask(existing.taskId, { title: fields.title, description: fields.description, due_date: fields.due_date, metadata: Object.assign({}, existing.task.metadata, fields.metadata) });
      if (!upd.ok) return fail(502, 'task_write_failed', 'That could not be saved. Please try again.');
      taskId = existing.taskId;
      changed = true;
    } else {
      const made = await ensureTask(L.caseRow, fields, KIND.EXIT_NOTICE, key, '', actor);
      if (!made.ok) return fail(502, 'task_write_failed', 'That could not be saved. Please try again.');
      taskId = made.taskId;
    }
    await ctx.logCaseEvent(L.caseRow.id, taskId, 'system', (changed ? 'Notice updated: last working day ' : 'Notice given: last working day ') + lastDay,
      'Recorded by ' + (actor || 'staff') + '. Reason: ' + (fees.EXIT_REASON_LABEL[reasonCode] || reasonCode) + (note ? ' (' + note + ')' : '')
      + '. The check-in and thank-you messages to the doctor and the practice are paused from now. The exit is recorded on the last working day.',
      actor || 'staff', { au: true, placement_key: key, notice_last_working_day: lastDay });
    ctx.invalidate();
    return { ok: true, status: 200, already: false, updated: changed, notice: { last_working_day: lastDay, reason: reasonCode, note: note || '', recorded_by: actor || 'staff' }, task_id: taskId };
  }

  /**
   * FR-1 (S-04). Fee, invoice and credit figures are the CEO's. Everything a
   * commencement route sends to a consultant or an RSO goes through this:
   * every key that carries one is set to null (the keys stay, so the card
   * draws "CEO only" rather than breaking), wherever it sits in the reply.
   * Dates, the stage, the guarantee period and the tasks are untouched.
   */
  const COMMERCIAL_KEYS = Object.freeze(['fee', 'fee_preview', 'fee_tier', 'fee_amount_ex_gst', 'amount_ex_gst', 'agreement_variant', 'agreement_variant_label',
    'candidate_basis', 'invoice', 'invoice_due_at', 'invoice_sent_at', 'invoice_paid_at', 'invoice_reference', 'invoice_payment_due_by',
    'invoiceDueAt', 'invoiceSentAt', 'invoicePaidAt', 'credit', 'credit_pct', 'schedule_band_pct', 'previous_fee', 'amountExGst', 'creditPct', 'scheduleBandPct']);
  function redactCommercial(value, role) {
    if (role === 'super_admin') return value;
    const walk = function (v) {
      if (Array.isArray(v)) return v.map(walk);
      if (!v || typeof v !== 'object') return v;
      const out = {};
      Object.keys(v).forEach(function (k) { out[k] = COMMERCIAL_KEYS.indexOf(k) !== -1 ? null : walk(v[k]); });
      return out;
    };
    const out = walk(value);
    if (out && typeof out === 'object' && !Array.isArray(out)) out.commercial_hidden = true;
    return out;
  }

  /**
   * FB-2b (W3-D15): "Placement ended", for a doctor who leaves AFTER the
   * guarantee period. The same record as an early exit (last working day,
   * reason, the placement marked ended, the case completed, WP-08's re-entry
   * rule opened, a task so the CEO knows) with no credit question: the
   * agreement gives none after the guarantee period, and the answer comes
   * from the same schedule (`outside_guarantee_period`). A last working day
   * that turns out to be inside the guarantee period is refused (409
   * `within_guarantee_period`): that one needs the credit worked out.
   *
   * @param {{ last_working_day, reason, note? }} body
   */
  async function recordPlacementEnded(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    return recordEarlyExit(caseId, { last_working_day: b.last_working_day, reason: b.reason, note: b.note }, actor, 'after_guarantee');
  }

  /** CEO only: the credit a person decided when the schedule could not give one. */
  async function recordCreditDecision(caseId, body, actor) {
    const b = body && typeof body === 'object' ? body : {};
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    if (!row || !fees.cleanDay(row.ended_at)) return fail(409, 'not_ended', 'A credit is only decided once the doctor is recorded as having left.');
    const reason = cleanText(b.reason, 500);
    if (reason.length < REASON_MIN) return fail(400, 'reason_required', 'Please say how the credit was decided (at least ' + REASON_MIN + ' characters).');
    const raw = b.credit_pct;
    const pct = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return fail(400, 'invalid_credit', 'The credit must be a percentage between 0 and 100.');
    const pctWas = row.credit_pct === null || row.credit_pct === undefined ? null : Number(row.credit_pct);
    if (pctWas !== null && pctWas === pct) return { ok: true, status: 200, credit_pct: pct, unchanged: true };
    // Compare-and-set on the credit this request read: a double submit is one decision, logged once.
    const write = await db('placements', 'id=eq.' + enc(row.id) + '&credit_pct=' + (pctWas === null ? 'is.null' : 'eq.' + enc(pctWas)),
      { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { credit_pct: pct } });
    if (!write.ok) return fail(502, 'placement_write_failed', 'That could not be saved. Please try again.');
    if (!Array.isArray(write.data) || !write.data.length) {
      const again = await load(caseId);
      const now = again.error || !again.row || again.row.credit_pct === null || again.row.credit_pct === undefined ? null : Number(again.row.credit_pct);
      if (now === pct) return { ok: true, status: 200, credit_pct: pct, unchanged: true };
      return fail(409, 'credit_conflict', 'The credit has just been changed by someone else. Please reload and check.');
    }
    const key = L.placement.key;
    const lc = await lifecycleTasks(L.caseRow.id, key);
    for (const t of lc.tasks.filter(function (x) { return x.metadata.lifecycle_kind === KIND.REPLACEMENT_OR_CREDIT; })) {
      await patchTask(t.id, { metadata: Object.assign({}, t.metadata, { credit_known: true, credit_pct: pct, credit_reason: 'decided_by_staff', credit_needs_decision: [], credit_decided_by: actor || 'staff' }) });
    }
    await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Guarantee credit decided: ' + pct + '%',
      'Decided by ' + (actor || 'staff') + '. ' + reason, actor || 'staff', { au: true, placement_key: key, credit_pct: pct });
    ctx.invalidate();
    return { ok: true, status: 200, credit_pct: pct };
  }

  // ── Close at the end of the guarantee period ───────────────────────────────

  async function sendReferralAsk(userId, names, key) {
    const msg = messages.buildReferralAskMessage({ appBaseUrl: ctx.appBaseUrl(), practiceName: names.practiceName, placementKey: key, teamLabel: auGpApp.teamLabel(true) });
    return ctx.sendDoctorMessage(userId, msg);
  }

  /**
   * The guarantee period has ended with the doctor still there: the case is
   * complete. Called by the daily job the day after the period ends, and by
   * the CEO's "Close case". Refused before the period has ended.
   */
  async function closeGuarantee(caseId, actor, opts) {
    const o = opts || {};
    const L = o.loaded || await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const commenced = row ? fees.cleanDay(row.commenced_at) : '';
    if (!row || !commenced) return fail(409, 'not_commenced', 'Commencement has not been confirmed for this placement.');
    if (fees.cleanDay(row.ended_at)) return fail(409, 'placement_ended', 'This placement ended early; the case was closed then.');
    const ends = fees.cleanDay(row.guarantee_ends_at) || fees.guaranteeEndsOn(commenced);
    const today = o.today || todayAt(await practiceFor(row));
    if (today <= ends) return fail(409, 'guarantee_not_ended', 'The guarantee period runs until ' + lifecycle.longDay(ends) + '. The case can be closed the day after.');
    const stage = await ctx.advanceStage(L.caseRow.id, 'complete', actor || 'system', { reason: 'Guarantee period ended ' + ends + ' with the doctor in place' });
    let referral = null;
    if (o.sendReferral !== false) {
      const names = o.names || await namesFor(L);
      try { referral = await sendReferralAsk(L.caseRow.user_id, names, L.placement.key); } catch (e) { referral = null; }
    }
    if (stage && stage.moved) {
      await ctx.logCaseEvent(L.caseRow.id, null, 'system', 'Guarantee period ended: case complete',
        'The 12-week guarantee period ended on ' + ends + ' with the doctor in place.'
        + (referral ? ' Doctor thanked (N20): email ' + (referral.email.sent ? 'sent' : referral.email.reason) + ', bell ' + (referral.bell.sent ? 'sent' : referral.bell.reason) + '.' : ''),
        actor || 'system', { au: true, placement_key: L.placement.key, guarantee_ends_at: ends });
      ctx.invalidate();
    }
    return { ok: true, status: 200, guarantee_ends_at: ends, stage, referral };
  }

  // ── What staff see ─────────────────────────────────────────────────────────

  async function staffView(caseId, role) {
    const L = await load(caseId);
    if (L.error) return L.error;
    const row = L.row;
    const isCeo = role === 'super_admin';
    const isConsultant = role === 'consultant';
    const out = {
      ok: true, status: 200, case_id: L.caseRow.id, stage: L.caseRow.stage,
      stage_label: journeyLadders.stageLabel(L.caseRow.stage, L.pathway.pathway),
      role: isCeo ? 'ceo' : (isConsultant ? 'consultant' : 'rso'),
      placement: null, state: null, fee_preview: null, prestart: null, tasks: [],
      exit_reasons: fees.EXIT_REASONS.map(function (v) { return { value: v, label: fees.EXIT_REASON_LABEL[v] }; }),
      can: { confirm: false, correct: false, undo: false, invoice_sent: false, invoice_paid: false, early_exit: false, placement_ended: false, credit_decision: false, close: false, notice: false, notice_withdraw: false },
      notice: null
    };
    if (!row) return redactCommercial(out, role);
    const practice = await practiceFor(row);
    const today = todayAt(practice);
    out.today = today;
    out.schema_missing = !Object.prototype.hasOwnProperty.call(row, 'commenced_at');
    const state = lifecycle.commercialState(row, today);
    out.state = state;
    const num = function (v) { return v === null || v === undefined || v === '' ? null : Number(v); };
    out.placement = {
      id: row.id, key: L.placement.key, status: row.status, practice_name: row.practice_name || '', job_title: row.job_title || '',
      start_date: fees.cleanDay(String(row.start_date || '')) || null, placed_at: row.placed_at || row.created_at || null,
      sessions_text: row.sessions_per_week || '', sessions_per_week_numeric: num(row.sessions_per_week_numeric),
      sessions_suggested: fees.cleanSessions(row.sessions_per_week),
      commenced_at: state.commencedAt, commencement_confirmed_by: row.commencement_confirmed_by || null,
      candidate_basis: row.candidate_basis || null, fee_tier: row.fee_tier || null, fee_amount_ex_gst: num(row.fee_amount_ex_gst),
      agreement_variant: row.agreement_variant || null, agreement_variant_label: variantLabel(row.agreement_variant),
      invoice_due_at: state.invoiceDueAt, invoice_sent_at: state.invoiceSentAt, invoice_reference: row.invoice_reference || null,
      invoice_paid_at: state.invoicePaidAt, invoice_payment_due_by: state.invoiceSentAt ? fees.invoicePaymentDueOn(state.invoiceSentAt) : null,
      guarantee_ends_at: state.guaranteeEndsAt, ended_at: state.endedAt, end_reason: row.end_reason || null, credit_pct: num(row.credit_pct)
    };
    if (!state.commenced) {
      const computed = computeFee(L.pathway, practice, row.sessions_per_week_numeric);
      out.fee_preview = {
        known: computed.fee.known, tier: computed.fee.tier, amount_ex_gst: computed.fee.known ? computed.fee.amountExGst : null,
        variant: computed.fee.variant, variant_label: variantLabel(computed.fee.variant), variant_known: computed.variant.known,
        reason: computed.fee.known ? null : computed.fee.reason,
        reason_text: computed.fee.known ? null : (lifecycle.FEE_UNKNOWN_TEXT[computed.fee.reason] || null),
        full_time_min_sessions: fees.FULL_TIME_MIN_SESSIONS
      };
      let pre = { ok: false, complete: false };
      try { pre = await ctx.prestartComplete(L.caseRow.id); } catch (e) { pre = { ok: false, complete: false }; }
      const label = function (t) { return (auPrestart.TASK_INFO[t] && auPrestart.TASK_INFO[t].label) || t; };
      // FB-2a (W3-D21): the required documents still to be approved are part
      // of the one definition, so staff are shown them with the open tasks.
      out.prestart = {
        complete: pre.ok === true && pre.complete === true, missing: (pre.missing || []).map(label),
        open: (pre.open || []).map(label).concat(prestartDocumentLabels(pre.documentsOutstanding, L.pathway)),
        documents_outstanding: pre.documentsOutstanding || [], counts: pre.counts || null
      };
    }
    const lc = await lifecycleTasks(L.caseRow.id, L.placement.key);
    // FR-1 (R-09): the notice on file, if the doctor has given one.
    const noticeNow = state.ended ? null : lifecycle.exitNoticeFrom(lc.tasks, L.placement.key);
    out.notice = noticeNow ? { last_working_day: noticeNow.lastWorkingDay, reason: noticeNow.reason, note: noticeNow.note, recorded_by: noticeNow.recordedBy, recorded_at: noticeNow.recordedAt } : null;
    // FR-1 (S-04): the CEO's commercial tasks are not listed for anyone else.
    out.tasks = lc.tasks.filter(function (t) { return t.metadata.undone !== true && (isCeo || lifecycle.CEO_COMMERCIAL_KINDS.indexOf(t.metadata.lifecycle_kind) === -1); }).map(function (t) {
      return { id: t.id, kind: t.metadata.lifecycle_kind, mark: t.metadata.mark || null, title: t.title, status: t.status, due_date: t.due_date || null, owner: t.metadata.owner || null };
    }).sort(function (a, b) { return String(a.due_date || '').localeCompare(String(b.due_date || '')); });
    const active = row.status === 'active';
    out.can = {
      confirm: (isCeo || isConsultant) && active && !state.commenced,
      correct: isCeo && state.commenced && !state.ended,
      undo: isCeo && state.commenced && !state.ended && !state.invoiceSentAt && L.caseRow.stage !== 'complete',
      invoice_sent: isCeo && state.commenced && !state.invoicePaidAt,
      invoice_paid: isCeo && !!state.invoiceSentAt && !state.invoicePaidAt,
      // FB-2b (W3-D15): "Doctor left during the guarantee" is offered only
      // while the guarantee period is running. Once it has ended the action
      // on offer is "Placement ended" (no credit question). The server still
      // judges each by the last working day typed in (see recordEarlyExit).
      early_exit: (isCeo || isConsultant) && state.commenced && !state.ended && state.inGuarantee === true,
      placement_ended: (isCeo || isConsultant) && state.commenced && !state.ended && state.inGuarantee !== true,
      credit_decision: isCeo && state.ended,
      close: isCeo && state.commenced && !state.ended && !!state.guaranteeEndsAt && today > state.guaranteeEndsAt && L.caseRow.stage !== 'complete',
      // R-09: notice can be recorded while the placement is running.
      notice: (isCeo || isConsultant) && state.commenced && !state.ended,
      notice_withdraw: (isCeo || isConsultant) && state.commenced && !state.ended && !!noticeNow
    };
    return redactCommercial(out, role);
  }

  // ── The daily lifecycle job (COM-40) ───────────────────────────────────────

  async function claim(userId, key) { return ctx.claimOnce(userId, key, 'lifecycle'); }
  async function unclaim(userId, key) { try { await ctx.releaseClaim(userId, key, 'lifecycle'); } catch (e) { /* stays claimed */ } }

  // One reminder task, once. The "once" is the task itself: ensureTask and the
  // unique index behind it (case, placement, kind, mark). Two overlapping runs
  // of the job, or the job overlapping a person, raise one; a run that died
  // before writing it leaves nothing behind, so the next run raises it.
  // true only for the caller that actually created the task.
  async function raiseReminderTask(caseRow, item, fields, placementKey) {
    if (!fields) return false;
    const made = await ensureTask(caseRow, fields, item.kind, placementKey, item.mark || '', 'system:au-lifecycle');
    return made.ok === true && made.created === true;
  }

  /**
   * One reminder MESSAGE has one owner. The run that claims the reminder's
   * key (`au_lc:<kind>:<placement>:<mark>`, channel `lifecycle`; atomic through
   * the ledger's unique index) sends every part of it and writes the one
   * timeline line; any other run that overlaps does nothing. Each part still
   * has its own ledger key underneath, so even a claim handed back never sends
   * a part twice. `fn` answers true when the doctor's email is settled (sent
   * now or before); otherwise the claim is handed back and the next run tries
   * again.
   */
  async function sendOnce(userId, itemKey, fn) {
    if (!(await claim(userId, itemKey))) return false;
    let settled = false;
    try { settled = (await fn()) === true; }
    catch (err) { settled = false; }
    if (!settled) await unclaim(userId, itemKey);
    return settled;
  }
  function doctorEmailSettled(result) {
    const e = result && result.email;
    return !!(e && (e.sent === true || e.reason === 'already_sent'));
  }

  async function sendPracticeWhatsApp(msg, phone, label) {
    const plan = auWhatsAppTemplates.auDoctorWhatsAppPlan(msg.whatsapp.templateKey);
    if (!plan.send) {
      console.log('[au-lifecycle] ' + label + ' WhatsApp skipped (' + plan.reason + '): no approved Australian template for "' + msg.whatsapp.templateKey + '"');
      return { sent: false, reason: plan.reason };
    }
    if (!phone) return { sent: false, reason: 'no_phone' };
    try {
      const sent = await ctx.sendWhatsAppTemplate(phone, plan.templateName, msg.whatsapp.placeholders, []);
      return sent && sent.ok ? { sent: true, template: plan.templateName } : { sent: false, reason: (sent && (sent.skipped || sent.error)) || 'not_sent' };
    } catch (e) { return { sent: false, reason: 'threw' }; }
  }

  // N18: the doctor (email, bell, WhatsApp through an approved Australian
  // template only) and the practice (email; WhatsApp the same rule).
  async function sendWeek1Messages(userId, names, key) {
    const out = { id: 'N18' };
    const gpMsg = messages.buildCommencementCheckinGpMessage({ appBaseUrl: ctx.appBaseUrl(), practiceName: names.practiceName, placementKey: key, teamLabel: auGpApp.teamLabel(true) });
    out.gp = await ctx.sendDoctorMessage(userId, gpMsg);
    out.gp.whatsapp = { sent: false };
    try {
      const plan = auWhatsAppTemplates.auDoctorWhatsAppPlan(gpMsg.whatsapp.templateKey);
      if (!plan.send) {
        out.gp.whatsapp.reason = plan.reason;
        console.log('[au-lifecycle] N18 WhatsApp to the doctor skipped (' + plan.reason + '): no approved Australian template for "' + gpMsg.whatsapp.templateKey + '"');
      } else if (await ctx.claimOnce(userId, gpMsg.key, 'whatsapp')) {
        const who = await ctx.lookupGpPhone(userId);
        const sent = who && who.phone
          ? await ctx.sendWhatsAppTemplate(who.phone, plan.templateName, [who.firstName || 'there', gpMsg.whatsapp.placeholders[1]], [])
          : { ok: false, skipped: 'no_phone' };
        if (sent && sent.ok) { out.gp.whatsapp.sent = true; out.gp.whatsapp.template = plan.templateName; }
        else { out.gp.whatsapp.reason = (sent && (sent.skipped || sent.error)) || 'not_sent'; await ctx.releaseClaim(userId, gpMsg.key, 'whatsapp'); }
      } else out.gp.whatsapp.reason = 'already_sent';
    } catch (e) { out.gp.whatsapp.reason = 'threw'; }
    const prMsg = messages.buildCommencementCheckinPracticeMessage({ gpName: names.gpName, contactName: names.practiceContactName, placementKey: key });
    out.practice = await ctx.sendPracticeMessage(userId, names.practiceEmail, prMsg);
    // The practice WhatsApp goes only with the email (so it is once), and only
    // through an approved Australian template: today none is approved.
    out.practice.whatsapp = out.practice.sent ? await sendPracticeWhatsApp(prMsg, names.practicePhone || '', 'N18 practice') : { sent: false, reason: 'email_not_sent_this_run' };
    return out;
  }

  async function sendWeekCheckinMessages(userId, names, key, week, guaranteeEndsAt) {
    const out = { id: 'N19', week };
    out.gp = await ctx.sendDoctorMessage(userId, messages.buildWeekCheckinGpMessage({
      appBaseUrl: ctx.appBaseUrl(), practiceName: names.practiceName, placementKey: key, week, teamLabel: auGpApp.teamLabel(true)
    }));
    out.practice = await ctx.sendPracticeMessage(userId, names.practiceEmail, messages.buildWeekCheckinPracticeMessage({
      gpName: names.gpName, contactName: names.practiceContactName, placementKey: key, week, guaranteeEndsAt
    }));
    return out;
  }

  function sentSomething(m) {
    return !!(m && ((m.gp && ((m.gp.email && m.gp.email.sent) || (m.gp.bell && m.gp.bell.sent))) || (m.practice && m.practice.sent)));
  }
  function describe(m) {
    const gp = m.gp || { email: {}, bell: {} };
    return 'doctor email ' + (gp.email.sent ? 'sent' : (gp.email.reason || 'not sent')) + ', bell ' + (gp.bell.sent ? 'sent' : (gp.bell.reason || 'not sent'))
      + (gp.whatsapp ? ', WhatsApp ' + (gp.whatsapp.sent ? 'sent' : 'skipped (' + gp.whatsapp.reason + ')') : '')
      + (m.practice ? '; practice email ' + (m.practice.sent ? 'sent' : (m.practice.reason || 'not sent')) : '');
  }

  /**
   * COM-40. One pass a day over doctors on an Australian pathway only.
   *
   *   0  the yearly Ahpra re-check and renewal reminder (WP-06's function)
   *   1  the pre-start pass (WP-11's function: held placements, unfinished
   *      steps, N13)
   *   2  placements not yet started: provider number still pending, indemnity
   *      certificate running out, notice not recorded, start date close with
   *      pre-start unfinished, start date reached with commencement not
   *      confirmed
   *   3  placements that have started: N18 at week 1, N19 at weeks 4 / 8 / 12,
   *      guarantee ending in 14 days, the end of the guarantee period (case
   *      complete, N20), an invoice past its terms, the part-time check at
   *      months 6 and 12
   *
   * Every reminder happens once: staff tasks and escalations are claimed in
   * the once-ever ledger (gp_nudge_log, channel `lifecycle`) before they are
   * written, and each message has its own ledger key. A doctor who is not on
   * an Australian pathway is never read past the pathway check. Switch off:
   * returns at once, nothing queried. Never throws.
   *
   * @param {number} [atMs]  the clock (tests pin it); defaults to now
   */
  async function runLifecycleSweep(atMs) {
    const at = Number.isFinite(atMs) ? atMs : nowMs();
    const out = { ok: false, at: new Date(at).toISOString(), prestart_cases: 0, commenced_placements: 0, fired: [], skipped_not_au: 0 };
    if (!ctx.switchOn() || !ctx.dbConfigured()) { out.reason = 'feature_off'; return out; }
    const fire = function (kind, userId, detail) { out.fired.push(Object.assign({ kind, user_id: userId }, detail || {})); };
    const dayAt = function (practice) { return lifecycle.localDay(at, zoneFor(practice)); };
    // WP-16 (COM-22, walk finding R10): quiet hours for the lifecycle
    // MESSAGES (N18, N19, N20). They go because time has passed, so they are
    // only sent between 08:00 and 20:00 on the practice's clock (after
    // commencement the doctor works there, and the practice gets the same
    // message). Outside the hours the message is DEFERRED: nothing is sent and
    // nothing is claimed, so the next run inside the hours sends it. Staff
    // tasks, stage moves and repairs are never held back. The daily host runs
    // at 20:30 UTC (early morning in Australia), so in practice these are sent
    // by the second, in-hours run (server.js runAuLifecycleInHoursPass).
    const quietAllows = function (practice, item, userId) {
      // A practice with no state on file: the zone is not known, so the send
      // must be inside the hours in every Australian zone.
      let known = '';
      try { known = auTimezone.zoneForAuState(practice && practice.location_state) || ''; } catch (e) { known = ''; }
      const q = auQuietHours.auQuietHoursAllowInZone(known, at);
      if (q.allow) return true;
      out.deferred_quiet_hours = (out.deferred_quiet_hours || 0) + 1;
      fire('deferred_quiet_hours', userId, { to: 'doctor and practice', channel: 'none', held: item.kind, mark: item.mark || (item.week ? 'w' + item.week : ''), local_time: q.localTime, zone: q.zone });
      return false;
    };

    try { out.au_ahpra_recheck = await ctx.runAhpraRecheck({ actor: 'system:au-lifecycle', now: new Date(at) }); }
    catch (e) { console.error('[au-lifecycle] Ahpra re-check failed (ignored):', e && e.message); out.au_ahpra_recheck = { ok: false, reason: 'threw' }; }

    // FB-2a (R16): THE REQUEST BUDGET (CONVENTIONS section 29). This job reads
    // per RUN, not per doctor. Who is on an Australian pathway comes from the
    // sweep index (two reads for the run, shared with the pre-start pass
    // below); what each section needs for all of its doctors is read once per
    // table (`batch`); and whether anything is owed is worked out in memory
    // from those rows. Only a doctor who IS owed something (a task to raise, a
    // message to send, a stage to move, a commencement to repair) costs more.
    // A read that could not be made means "do nothing for these doctors this
    // run", never "nothing found". It used to resolve the pathway and read the
    // case, the practice, the credentials, the doctor's details and
    // preferences and the tasks one doctor at a time.
    let index = null;
    try { index = ctx.sweepIndex ? await ctx.sweepIndex('au-lifecycle') : null; } catch (e) { index = null; }
    const indexOk = !!(index && index.enabled && !index.unreadable);
    // A resolver-shaped answer from the index: enough to say "Australian" and
    // to read the document requirements. Anything that needs the doctor's
    // basis (the fee) resolves the pathway properly, when it is owed.
    const indexPathway = function (userId) {
      const pw = indexOk ? index.pathwayOf(userId) : '';
      return pw ? candidatePathway.resolvePathwayFromRecords({ profile: { candidate_pathway: pw }, credentials: null, flagEnabled: true }) : null;
    };
    const batch = async function (table, select, column, ids, extra) {
      if (!ctx.batchRead) return { ok: false, rows: [] };
      try { return await ctx.batchRead(table, select, column, ids, extra); } catch (e) { return { ok: false, rows: [] }; }
    };
    const groupBy = function (rows, key) {
      const m = {};
      (rows || []).forEach(function (r) { if (r && r[key] != null) (m[String(r[key])] = m[String(r[key])] || []).push(r); });
      return m;
    };
    const withMeta = function (t) {
      let meta = t.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = {}; } }
      return Object.assign({}, t, { metadata: meta && typeof meta === 'object' ? meta : {} });
    };
    // Has this reminder already been dealt with? A task reminder: its task
    // exists (the unique index's own key). A message reminder, and the
    // provider-number escalation: its key is claimed in the ledger (a claim is
    // only kept once the message is settled).
    const TASK_REMINDER_KINDS = [KIND.START_REACHED, KIND.PRESTART_AT_RISK, KIND.NOTICE, KIND.INDEMNITY, KIND.GUARANTEE_ENDING, KIND.UPLIFT, KIND.INVOICE_OVERDUE];
    const alreadyDealtWith = function (item, tasks, claimed, placementKey) {
      if (TASK_REMINDER_KINDS.indexOf(item.kind) !== -1) return (tasks || []).some(matcher(item.kind, placementKey, item.mark || ''));
      return !!(claimed && claimed[String(item.key)]);
    };

    try { out.au_prestart = await ctx.runPrestartSweep({ now: new Date(at), index: indexOk ? index : undefined }); }
    catch (e) { console.error('[au-lifecycle] pre-start pass failed (ignored):', e && e.message); out.au_prestart = { ok: false, reason: 'threw' }; }

    // ── 2. not yet started ──────────────────────────────────────────────────
    try {
      const cases = await db('registration_cases',
        'select=id,user_id,stage,status,created_at,completed_at,assigned_va,assigned_rso&stage=eq.prestart&status=eq.active&limit=200');
      // An overseas doctor's case is dropped here, before anything is read about it.
      const all2 = cases.ok && Array.isArray(cases.data) ? cases.data : [];
      const mine2 = indexOk ? all2.filter(function (c) { return c && c.id && c.user_id && index.isAuUser(c.user_id); }) : [];
      out.skipped_not_au += indexOk ? all2.length - mine2.length : 0;
      let B2 = null;
      if (mine2.length) {
        const users = mine2.map(function (c) { return c.user_id; });
        const caseIds = mine2.map(function (c) { return c.id; });
        const [pl, tk, docs, det, prefs, cred, led] = await Promise.all([
          batch('placements', '*', 'user_id', users),
          batch('registration_tasks', 'id,case_id,status,task_type,title,due_date,source_trigger,metadata,related_document_key', 'case_id', caseIds),
          batch('user_documents', 'user_id,document_key,status,country_code', 'user_id', users, '&country_code=eq.' + enc(documentCountry.AU_DOCUMENT_COUNTRY)),
          batch('au_gp_doctor_details', 'user_id,notice_given,notice_given_date,notice_placement_key', 'user_id', users),
          batch('user_profiles', 'user_id,notice_period_weeks', 'user_id', users),
          batch('gp_credentials', 'user_id,indemnity_expiry', 'user_id', users),
          batch('gp_nudge_log', 'user_id,nudge_key,channel', 'user_id', users, '&channel=eq.lifecycle')
        ]);
        // The placements, the tasks, the documents and the ledger decide what
        // is owed: without any one of them nothing is done this run. (The
        // doctor's details and preferences only refine a prompt: a database
        // without them means "nothing recorded", as before.)
        if (pl.ok && tk.ok && docs.ok && led.ok && cred.ok) {
          const practiceIds = Array.from(new Set(pl.rows.map(function (r) { return r && r.practice_id ? String(r.practice_id) : ''; }).filter(Boolean)));
          const pr = practiceIds.length ? await batch('practices', '*', 'id', practiceIds) : { ok: true, rows: [] };
          if (pr.ok) {
            const practiceById = {};
            pr.rows.forEach(function (r) { practiceById[String(r.id)] = r; });
            const approvedByUser = {};
            docs.rows.forEach(function (r) {
              if (!r || !documentRequirements.isAuRegDocumentKey(r.document_key) || String(r.status || '').toLowerCase() !== 'approved') return;
              (approvedByUser[String(r.user_id)] = approvedByUser[String(r.user_id)] || []).push(String(r.document_key));
            });
            const claimedByUser = {};
            led.rows.forEach(function (r) { (claimedByUser[String(r.user_id)] = claimedByUser[String(r.user_id)] || {})[String(r.nudge_key)] = true; });
            B2 = {
              placementsByUser: groupBy(pl.rows, 'user_id'), tasksByCase: groupBy(tk.rows.map(withMeta), 'case_id'), practiceById, approvedByUser, claimedByUser,
              detailsByUser: det.ok ? groupBy(det.rows, 'user_id') : {}, prefsByUser: prefs.ok ? groupBy(prefs.rows, 'user_id') : {}, credByUser: groupBy(cred.rows, 'user_id')
            };
          }
        }
        if (!B2) out.prestart_unreadable = true;
      }
      for (const caseRow of (B2 ? mine2 : [])) {
        try {
          const p = indexPathway(caseRow.user_id);
          if (!p) continue;
          const rows = (B2.placementsByUser[String(caseRow.user_id)] || []).slice().sort(byPlacedDesc);
          const row = (rows || []).filter(function (r) { return r && r.status === 'active' && !fees.cleanDay(r.commenced_at); })[0] || null;
          if (!row) continue;
          out.prestart_cases += 1;
          const L = { caseRow, pathway: p, rows, row, placement: shapeOf(row) };
          const key = L.placement.key;
          const practice = row.practice_id ? (B2.practiceById[String(row.practice_id)] || null) : null;
          const today = dayAt(practice);
          const caseTasks = B2.tasksByCase[String(caseRow.id)] || [];
          // The one definition of "pre-start complete" (lib/au-prestart.js),
          // over the rows in hand. The pre-start pass above has just kept the
          // tasks in step with the facts.
          const pre = auPrestart.prestartCompletion({
            tasks: caseTasks.filter(function (t) {
              return auPrestart.PRESTART_TASK_TYPES.indexOf(t.task_type) !== -1
                && (String(t.metadata.placement_key || '') === String(key) || (t.metadata.created_by_hand === true && !t.metadata.placement_key));
            }),
            requiredDocumentKeys: auPrestart.requiredPrestartDocumentKeys(documentRequirements.auDocumentRequirements(p)),
            approvedDocumentKeys: B2.approvedByUser[String(caseRow.user_id)] || []
          });
          const details = (B2.detailsByUser[String(caseRow.user_id)] || [])[0] || null;
          const prefs = (B2.prefsByUser[String(caseRow.user_id)] || [])[0] || null;
          const cred = (B2.credByUser[String(caseRow.user_id)] || [])[0] || null;
          const dueAll = lifecycle.prestartRemindersDue({
            today, placementKey: key,
            // ADM-04: aged from the placement milestone (auCaseAgeAnchor),
            // never from GP activity; and counted in CALENDAR days at the
            // practice, not in elapsed 24-hour periods.
            ageDays: (function () {
              const anchor = auSweeps.auCaseAgeAnchor(caseRow, row);
              const anchorMs = anchor && anchor.at ? Date.parse(anchor.at) : NaN;
              return Number.isFinite(anchorMs) ? fees.daysBetween(lifecycle.localDay(anchorMs, zoneFor(practice)), today) : NaN;
            })(),
            startDate: row.start_date,
            prestartComplete: pre.complete === true,
            providerTaskOpen: (pre.open || []).indexOf(auPrestart.TASK_TYPE.PROVIDER_NUMBER_NEW_LOCATION) !== -1,
            noticeGiven: !!(details && details.notice_given === true && String(details.notice_placement_key || '') === String(key)),
            noticeWeeks: prefs ? prefs.notice_period_weeks : null,
            indemnityExpiry: cred ? cred.indemnity_expiry : null
          });
          // Only what has not been dealt with yet is owed.
          const due = dueAll.filter(function (item) { return !alreadyDealtWith(item, caseTasks, B2.claimedByUser[String(caseRow.user_id)], key); });
          if (!due.length) continue;
          const names = await namesFor(L);
          const base = { name: names.gpName, practiceName: names.practiceName, placementKey: key, applicationId: L.placement.applicationId, placingConsultant: names.placingConsultant, stage: 'prestart', today };
          for (const item of due) {
            if (item.kind === KIND.PROVIDER_PENDING) {
              if (!(await claim(caseRow.user_id, item.key))) continue;
              const tasks = await ctx.tasksOfType(caseRow.id, auPrestart.TASK_TYPE.PROVIDER_NUMBER_NEW_LOCATION);
              const open = tasks.ok ? tasks.tasks.filter(function (t) { return isOpenTask(t) && String(t.metadata.placement_key || '') === String(key); })[0] : null;
              if (!open) { await unclaim(caseRow.user_id, item.key); continue; }
              await patchTask(open.id, { priority: 'high' });
              await ctx.logCaseEvent(caseRow.id, open.id, 'system', 'Provider number still pending ' + item.ageDays + ' days after the placement',
                'The Medicare provider number for the new location has not been recorded. The task is now high priority.', 'system:au-lifecycle', { au: true, placement_key: key });
              fire(item.kind, caseRow.user_id, { to: 'staff (RSO)', channel: 'task escalated' });
              continue;
            }
            let fields = null;
            if (item.kind === KIND.START_REACHED) fields = lifecycle.buildLifecycleTask(KIND.START_REACHED, Object.assign({}, base, { mark: item.mark, startDate: item.startDate, dueDate: today }));
            else if (item.kind === KIND.PRESTART_AT_RISK) {
              const label = function (t) { return (auPrestart.TASK_INFO[t] && auPrestart.TASK_INFO[t].label) || t; };
              fields = lifecycle.buildLifecycleTask(KIND.PRESTART_AT_RISK, Object.assign({}, base, {
                mark: item.mark, startDate: item.startDate, daysToStart: item.daysToStart, dueDate: today,
                outstanding: (pre.open || []).concat(pre.missing || []).map(label).concat(prestartDocumentLabels(pre.documentsOutstanding, p))
              }));
            } else if (item.kind === KIND.NOTICE) fields = lifecycle.buildLifecycleTask(KIND.NOTICE, Object.assign({}, base, { mark: item.mark, startDate: item.startDate, noticeWeeks: item.noticeWeeks, dueDate: fees.addDays(today, 2) }));
            else if (item.kind === KIND.INDEMNITY) fields = lifecycle.buildLifecycleTask(KIND.INDEMNITY, Object.assign({}, base, { mark: item.mark, expiry: item.expiry, beforeStart: item.beforeStart, startDate: item.startDate, dueDate: fees.addDays(today, 3) }));
            if (await raiseReminderTask(caseRow, item, fields, key)) fire(item.kind, caseRow.user_id, { to: 'staff (' + fields.metadata.owner + ')', channel: 'task', mark: item.mark });
          }
        } catch (rowErr) {
          console.error('[au-lifecycle] pre-start case ' + caseRow.id + ' failed (ignored):', rowErr && rowErr.message);
        }
      }
    } catch (err) {
      console.error('[au-lifecycle] pre-start reminders failed:', err && err.message);
    }

    // ── 3. started ──────────────────────────────────────────────────────────
    try {
      // Names a WP-13 column: switch on only, and a database without the
      // migration answers 400, which simply means "nobody has commenced".
      const read = await db('placements', 'select=*&commenced_at=not.is.null&status=eq.active&limit=500');
      if (!read.ok) out.commenced_unreadable = true;
      // FB-2a (W3-D3): a doctor placed a second time can still have the row
      // of an EARLIER placement here (active, started, its guarantee period
      // long over, the doctor has since moved on). That row is still tracked
      // commercially, but it must never move the case: the case now belongs to
      // the newer placement. Without this, the day after cycle two began the
      // job would have "completed" the case again for placement one, or moved
      // a case in pre-start for placement two straight to "commenced".
      // One read for the whole run; unreadable means no stage is moved here.
      const newestActive = {};
      let currentKnown = false;
      if (read.ok && Array.isArray(read.data) && read.data.length) {
        const active = await db('placements', 'select=id,user_id,placed_at,created_at&status=eq.active&limit=1000');
        if (active.ok && Array.isArray(active.data)) {
          currentKnown = true;
          active.data.forEach(function (r) {
            if (!r || !r.user_id) return;
            const k = String(r.user_id);
            const cur = newestActive[k];
            if (!cur || String(r.placed_at || r.created_at || '').localeCompare(String(cur.placed_at || cur.created_at || '')) > 0) newestActive[k] = r;
          });
        }
      }
      const isCurrentPlacement = function (r) {
        const newest = currentKnown ? newestActive[String(r.user_id)] : null;
        return !!newest && String(newest.id) === String(r.id);
      };
      // FB-2a (R16): what the commenced placements need, read once for all of
      // them. An overseas doctor's row is dropped before anything is read.
      const all3 = read.ok && Array.isArray(read.data) ? read.data : [];
      const mine3 = indexOk ? all3.filter(function (r) { return r && r.user_id && index.isAuUser(r.user_id); }) : [];
      out.skipped_not_au += indexOk ? all3.length - mine3.length : 0;
      let B3 = null;
      if (mine3.length) {
        const users = Array.from(new Set(mine3.map(function (r) { return String(r.user_id); })));
        const [cs, cred, led] = await Promise.all([
          batch('registration_cases', 'id,user_id,stage,status,assigned_va,assigned_rso', 'user_id', users),
          batch('gp_credentials', 'user_id,indemnity_expiry', 'user_id', users),
          batch('gp_nudge_log', 'user_id,nudge_key,channel', 'user_id', users, '&channel=eq.lifecycle')
        ]);
        if (cs.ok && cred.ok && led.ok) {
          const caseIds = cs.rows.map(function (c) { return c.id; });
          const practiceIds = Array.from(new Set(mine3.map(function (r) { return r.practice_id ? String(r.practice_id) : ''; }).filter(Boolean)));
          const [tk, pr] = await Promise.all([
            caseIds.length ? batch('registration_tasks', 'id,case_id,status,task_type,title,due_date,source_trigger,metadata,related_document_key', 'case_id', caseIds) : { ok: true, rows: [] },
            practiceIds.length ? batch('practices', '*', 'id', practiceIds) : { ok: true, rows: [] }
          ]);
          if (tk.ok && pr.ok) {
            const practiceById = {};
            pr.rows.forEach(function (r) { practiceById[String(r.id)] = r; });
            const claimedByUser = {};
            led.rows.forEach(function (r) { (claimedByUser[String(r.user_id)] = claimedByUser[String(r.user_id)] || {})[String(r.nudge_key)] = true; });
            B3 = { caseByUser: groupBy(cs.rows, 'user_id'), credByUser: groupBy(cred.rows, 'user_id'), tasksByCase: groupBy(tk.rows.map(withMeta), 'case_id'), practiceById, claimedByUser };
          }
        }
        if (!B3) out.commenced_unreadable = true;
      }
      for (const row of (B3 ? mine3 : [])) {
        try {
          const ownsCase = isCurrentPlacement(row);
          const commenced = fees.cleanDay(row && row.commenced_at);
          if (!row || !row.user_id || !commenced || row.status !== 'active' || fees.cleanDay(row.ended_at)) continue;
          let p = indexPathway(row.user_id);
          if (!p) continue;
          const caseRow = (B3.caseByUser[String(row.user_id)] || [])[0] || null;
          if (!caseRow) continue;
          out.commenced_placements += 1;
          const L = { caseRow, pathway: p, rows: [row], row, placement: shapeOf(row) };
          const key = L.placement.key;
          const practice = row.practice_id ? (B3.practiceById[String(row.practice_id)] || null) : null;
          const today = dayAt(practice);
          const cred = (B3.credByUser[String(row.user_id)] || [])[0] || null;
          const caseTasks = B3.tasksByCase[String(caseRow.id)] || [];
          // FR-1 (R-09): the doctor has given notice.
          //   last working day reached (the practice's own date): this run
          //     records the exit, with the credit rules exactly as built;
          //   still to come: every check-in and thank-you message for this
          //     placement is paused (nothing is claimed, so they resume if the
          //     notice is withdrawn in time). Staff tasks and stage moves go on.
          const notice = lifecycle.exitNoticeFrom(caseTasks, key);
          if (notice && notice.lastWorkingDay <= today && ownsCase) {
            const by = 'system:au-lifecycle (notice recorded by ' + (notice.recordedBy || 'staff') + ')';
            const exitBody = { last_working_day: notice.lastWorkingDay, reason: notice.reason, conditions_confirmed: 'unknown', note: notice.note };
            let exited = await recordEarlyExit(caseRow.id, exitBody, by);
            if (exited && exited.ok !== true && exited.use === 'placement-ended') exited = await recordPlacementEnded(caseRow.id, exitBody, by);
            if (exited && exited.ok) {
              out.notice_exits = (out.notice_exits || 0) + 1;
              fire('exit_from_notice', row.user_id, { to: 'case', channel: 'exit recorded', last_working_day: notice.lastWorkingDay });
            } else {
              console.error('[au-lifecycle] notice for placement ' + row.id + ' could not be turned into the exit (' + ((exited && exited.code) || 'unknown') + '); it stays open for staff');
            }
            continue;
          }
          // FR-2 (R2-05): a doctor who has closed their account, and their
          // practice, get no check-in or thank-you either.
          // Asked only when a message is actually about to go (no extra read
          // for a placement with nothing to send), and once per placement.
          let accountClosedMemo = null;
          const pausedNow = async function () {
            if (notice) return true;
            if (accountClosedMemo === null) {
              try { accountClosedMemo = ctx.accountClosed ? (await ctx.accountClosed(row.user_id)) === true : false; } catch (e) { accountClosedMemo = false; }
            }
            return accountClosedMemo;
          };
          const dueAll = lifecycle.commencedRemindersDue({
            today, placementKey: key, commencedAt: commenced, guaranteeEndsAt: row.guarantee_ends_at, feeTier: row.fee_tier,
            invoiceSentAt: row.invoice_sent_at, invoicePaidAt: row.invoice_paid_at, indemnityExpiry: cred ? cred.indemnity_expiry : null
          });
          // A commencement whose stage move did not land (a failed write) is
          // put right here: the row is the fact, the stage follows it.
          if (ownsCase && caseRow.stage === 'prestart') {
            const fixed = await ctx.advanceStage(caseRow.id, 'commenced', 'system:au-lifecycle', { reason: 'Commencement confirmed for ' + commenced });
            if (fixed && fixed.moved) { caseRow.stage = 'commenced'; fire('stage_commenced', row.user_id, { to: 'case', channel: 'stage' }); }
          }
          // ... and so are the tasks: a commencement whose derived tasks are not
          // all there (the request died between the stamp and the tasks) is
          // completed here, while the guarantee period is still running.
          let names = null;
          if (today <= (fees.cleanDay(row.guarantee_ends_at) || fees.guaranteeEndsOn(commenced))) {
            // From the tasks in hand: this placement's lifecycle tasks.
            const have = { ok: true, tasks: caseTasks.filter(function (t) { return t.metadata.lifecycle_kind && String(t.metadata.placement_key || '') === String(key); }) };
            if (have.ok) {
              const present = {};
              have.tasks.forEach(function (t) { if (t.metadata.undone !== true) present[t.metadata.lifecycle_kind + ':' + (t.metadata.mark || '')] = true; });
              const expected = [KIND.INVOICE + ':', KIND.WEEK1 + ':w1'].concat(fees.CHECKIN_WEEKS.map(function (w) { return KIND.CHECKIN + ':w' + w; }));
              if (expected.some(function (k) { return !present[k]; })) {
                // A repair is owed: the fee needs the doctor's real pathway (their basis).
                let pFull = null;
                try { pFull = await ctx.resolvePathway(row.user_id); } catch (e) { pFull = null; }
                if (pFull && !pFull.readFailed && pFull.isAu) { p = pFull; L.pathway = pFull; }
                names = await namesFor(L);
                const repaired = await ensureDerivedTasks(L, row, feeFromRow(row, p, practice), names, 'system:au-lifecycle');
                if (repaired.created.length) {
                  await ctx.logCaseEvent(caseRow.id, null, 'system', 'Commencement tasks completed by the daily job',
                    'Missing after commencement on ' + commenced + ' and now raised: ' + repaired.created.join(', ') + '.', 'system:au-lifecycle', { au: true, placement_key: key });
                  fire('derived_tasks_repaired', row.user_id, { to: 'staff', channel: 'tasks', created: repaired.created });
                }
              }
            }
          }
          // Only what is still owed: a reminder whose task exists, or whose
          // message is settled, is dropped here. A stage move that has not
          // happened yet keeps its item (the first week, the end of the
          // guarantee period), whatever was sent.
          const claimed = B3.claimedByUser[String(row.user_id)] || null;
          const due = dueAll.filter(function (item) {
            if (item.kind === KIND.WEEK1 && ownsCase && (caseRow.stage === 'commenced' || caseRow.stage === 'prestart')) return true;
            if (item.kind === KIND.GUARANTEE_ENDED && ownsCase && caseRow.stage !== 'complete') return true;
            if ((item.kind === KIND.WEEK1 || item.kind === KIND.CHECKIN || item.kind === KIND.GUARANTEE_ENDED) && item.stale) return false;
            return !alreadyDealtWith(item, caseTasks, claimed, key);
          });
          if (!due.length) continue;
          if (!names) names = await namesFor(L);
          if (practice) names.practicePhone = String(practice.contact_phone || '').trim();
          const base = { name: names.gpName, practiceName: names.practiceName, placementKey: key, applicationId: L.placement.applicationId, placingConsultant: names.placingConsultant, stage: taskStageFor(caseRow, 'guarantee'), today };
          for (const item of due) {
            if (item.kind === KIND.WEEK1) {
              // The first week is over: the case moves on, whatever else
              // happens. (Only asked while the case is still behind, so a
              // settled case costs nothing more each day.)
              if (ownsCase && (caseRow.stage === 'commenced' || caseRow.stage === 'prestart')) {
                const moved = await ctx.advanceStage(caseRow.id, 'guarantee', 'system:au-lifecycle', { reason: 'First week complete (commenced ' + commenced + ')' });
                if (moved && moved.moved) { caseRow.stage = 'guarantee'; fire('stage_guarantee', row.user_id, { to: 'case', channel: 'stage' }); }
              }
              if (item.stale) continue;
              if (await pausedNow()) { out.paused_for_notice = (out.paused_for_notice || 0) + 1; continue; }   // R-09, R2-05
              if (!quietAllows(practice, item, row.user_id)) continue;
              await sendOnce(row.user_id, item.key, async function () {
                const m = await sendWeek1Messages(row.user_id, names, key);
                if (sentSomething(m)) {
                  await ctx.logCaseEvent(caseRow.id, null, 'system', 'First-week check-in sent (N18)', describe(m), 'system:au-lifecycle', { au: true, placement_key: key });
                  fire(item.kind, row.user_id, { to: 'doctor and practice', channel: 'email, bell', result: describe(m) });
                }
                return doctorEmailSettled(m.gp);
              });
            } else if (item.kind === KIND.CHECKIN) {
              if (item.stale) continue;
              if (await pausedNow()) { out.paused_for_notice = (out.paused_for_notice || 0) + 1; continue; }   // R-09, R2-05
              if (!quietAllows(practice, item, row.user_id)) continue;
              await sendOnce(row.user_id, item.key, async function () {
                const m = await sendWeekCheckinMessages(row.user_id, names, key, item.week, fees.cleanDay(row.guarantee_ends_at) || fees.guaranteeEndsOn(commenced));
                if (sentSomething(m)) {
                  await ctx.logCaseEvent(caseRow.id, null, 'system', 'Week ' + item.week + ' check-in sent (N19)', describe(m), 'system:au-lifecycle', { au: true, placement_key: key, week: item.week });
                  fire(item.kind, row.user_id, { to: 'doctor and practice', channel: 'email, bell', week: item.week, result: describe(m) });
                }
                return doctorEmailSettled(m.gp);
              });
            } else if (item.kind === KIND.GUARANTEE_ENDING) {
              const st = lifecycle.commercialState(row, today);
              const invoiceState = st.invoice === 'paid' ? 'paid' : (st.invoice === 'overdue' ? 'sent and past its 7-day terms' : (st.invoice === 'sent' ? 'sent, not yet paid' : 'not yet recorded as sent'));
              const fields = lifecycle.buildLifecycleTask(KIND.GUARANTEE_ENDING, Object.assign({}, base, { mark: item.mark, guaranteeEndsAt: item.guaranteeEndsAt, invoiceState, dueDate: item.guaranteeEndsAt }));
              if (await raiseReminderTask(caseRow, item, fields, key)) fire(item.kind, row.user_id, { to: 'staff (consultant)', channel: 'task' });
            } else if (item.kind === KIND.GUARANTEE_ENDED) {
              // The stage first (compare-and-set: one run moves it, and only
              // that run writes the timeline line), then the thank-you, which
              // one run owns.
              if (ownsCase && caseRow.stage !== 'complete') {
                const closed = await closeGuarantee(caseRow.id, 'system:au-lifecycle', { loaded: L, today, names, sendReferral: false });
                if (closed.ok && closed.stage && closed.stage.moved) { caseRow.stage = 'complete'; fire(item.kind, row.user_id, { to: 'case', channel: 'stage complete' }); }
              }
              if (item.stale) continue;
              if (await pausedNow()) { out.paused_for_notice = (out.paused_for_notice || 0) + 1; continue; }   // R-09, R2-05: no thank-you to a doctor who is leaving
              if (!quietAllows(practice, item, row.user_id)) continue;
              await sendOnce(row.user_id, item.key, async function () {
                const referral = await sendReferralAsk(row.user_id, names, key);
                if (referral && (referral.email.sent || referral.bell.sent)) {
                  await ctx.logCaseEvent(caseRow.id, null, 'system', 'Twelve-week thank-you sent (N20)',
                    'doctor email ' + (referral.email.sent ? 'sent' : referral.email.reason) + ', bell ' + (referral.bell.sent ? 'sent' : referral.bell.reason), 'system:au-lifecycle', { au: true, placement_key: key });
                  fire('referral_ask', row.user_id, { to: 'doctor', channel: 'email, bell' });
                }
                return doctorEmailSettled(referral);
              });
            } else if (item.kind === KIND.UPLIFT) {
              const fields = lifecycle.buildLifecycleTask(KIND.UPLIFT, Object.assign({}, base, { mark: item.mark, month: item.month, commencedAt: commenced, dueDate: fees.addDays(today, 7) }));
              if (await raiseReminderTask(caseRow, item, fields, key)) fire(item.kind, row.user_id, { to: 'staff (ceo)', channel: 'task', month: item.month });
            } else if (item.kind === KIND.INVOICE_OVERDUE) {
              const fields = lifecycle.buildLifecycleTask(KIND.INVOICE_OVERDUE, Object.assign({}, base, {
                mark: item.mark, invoiceSentAt: item.invoiceSentAt, paymentDueBy: item.paymentDueBy, invoiceReference: row.invoice_reference, dueDate: today
              }));
              if (await raiseReminderTask(caseRow, item, fields, key)) fire(item.kind, row.user_id, { to: 'staff (ceo)', channel: 'task' });
            } else if (item.kind === KIND.INDEMNITY) {
              const fields = lifecycle.buildLifecycleTask(KIND.INDEMNITY, Object.assign({}, base, { mark: item.mark, expiry: item.expiry, beforeStart: false, dueDate: fees.addDays(today, 3) }));
              if (await raiseReminderTask(caseRow, item, fields, key)) fire(item.kind, row.user_id, { to: 'staff (rso)', channel: 'task' });
            }
          }
        } catch (rowErr) {
          console.error('[au-lifecycle] placement ' + (row && row.id) + ' failed (ignored):', rowErr && rowErr.message);
        }
      }
    } catch (err) {
      console.error('[au-lifecycle] commenced reminders failed:', err && err.message);
    }
    if (out.fired.length) ctx.invalidate();
    out.ok = true;
    return out;
  }

  // ── WP-27 hook: the commercial lists (no screen here) ──────────────────────

  /**
   * Invoices due, placements in their guarantee period, and the ones whose
   * guarantee period ends within 14 days. Switch off: empty, nothing queried.
   * @returns {Promise<{ ok, invoicesDue, inGuarantee, guaranteeEndingSoon, counts }>}
   */
  async function commercialSummary(atMs) {
    const empty = Object.assign({ ok: false }, lifecycle.commercialSummary([], ''));
    if (!ctx.switchOn() || !ctx.dbConfigured()) return empty;
    try {
      const read = await db('placements', 'select=*&commenced_at=not.is.null&limit=1000');
      if (!read.ok || !Array.isArray(read.data)) return empty;
      // Each placement is judged on its own practice's calendar date. `today`
      // in the answer is the fallback zone's date, for a heading only.
      const at = Number.isFinite(atMs) ? atMs : nowMs();
      const rows = read.data.filter(function (r) { return r && fees.cleanDay(r.commenced_at); });
      const dayFor = await practiceDays(rows, at);
      return Object.assign({ ok: true, today: lifecycle.localDay(at, lifecycle.FALLBACK_ZONE) }, lifecycle.commercialSummary(rows, dayFor));
    } catch (e) { return empty; }
  }

  return {
    confirmCommencement, correctCommencement, undoCommencement,
    markInvoiceSent, markInvoicePaid, recordEarlyExit, recordPlacementEnded, recordCreditDecision, closeGuarantee,
    recordExitNotice, redactCommercial,
    staffView, runLifecycleSweep, commercialSummary,
    placementRowsFor, currentRow, practiceDays
  };
}

module.exports = { createAuCommencement, REASON_MIN };
