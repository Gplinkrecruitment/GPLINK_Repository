'use strict';
/**
 * FB-2b (walk-findings W3-D23, R17): the name an Australian recipient is
 * greeted by. Pure.
 *
 * Two things went wrong with the existing greetings, both of which exist for
 * overseas recipients too and are left exactly as they are for them:
 *
 *   "Hi Test Fullwalk,"  a greeting built from the FULL name (the interview
 *                        invitation), which reads like a mail merge.
 *   "Hi Dr,"             a greeting built from "the first word of the name".
 *                        A lead who typed "Dr Jane Citizen" on the form was
 *                        greeted by their title alone on WhatsApp.
 *
 * The rule, for a doctor or lead on the Australian side:
 *
 *   firstNameFor(first, full)   the first name, with any leading title
 *                               skipped. '' when there is none that can be
 *                               trusted: a title followed by ONE word
 *                               ("Dr Citizen") is a surname, not a first name.
 *   greetingName(first, full)   what goes after "Hi ": the first name, else
 *                               "Dr Citizen" for a title and a surname, else
 *                               "there".
 *   greeting(first, full)       "Hi Jane," / "Hi Dr Citizen," / "Hi there,"
 *
 * A message whose template has ONE word for the name (a WhatsApp variable)
 * uses `firstNameFor(...) || 'there'`, never the title on its own.
 *
 * The browser's twin is `GPAuDoctor.firstNameFor` / `greeting`
 * (js/au-doctor.js); tests/au-fb2b-greeting.test.js keeps the two equal.
 */

const TITLES = Object.freeze(['dr', 'doctor', 'prof', 'professor', 'mr', 'mrs', 'ms', 'miss', 'mx', 'assoc', 'a/prof']);

function words(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}
function isTitle(word) {
  return TITLES.indexOf(String(word || '').toLowerCase().replace(/\.$/, '')) !== -1;
}
function cleanWord(word) {
  const w = String(word || '').replace(/[.,;:]+$/, '');
  return /[A-Za-zÀ-ɏ]/.test(w) ? w : '';
}
// { first, surnameOnly } for one raw name.
function parse(raw) {
  const list = words(raw);
  let titled = false;
  while (list.length && isTitle(list[0])) { list.shift(); titled = true; }
  if (!list.length) return { first: '', surnameOnly: '' };
  if (titled && list.length === 1) return { first: '', surnameOnly: cleanWord(list[0]) };
  return { first: cleanWord(list[0]), surnameOnly: '' };
}

function firstNameFor(firstName, fullName) {
  // The first-name FIELD holds a first name: a title in front of it is
  // skipped and what follows is the name ("Dr. Jane" is Jane).
  const own = parse(firstName);
  return own.first || own.surnameOnly || parse(fullName).first;
}

function greetingName(firstName, fullName) {
  const first = firstNameFor(firstName, fullName);
  if (first) return first;
  const surname = parse(fullName).surnameOnly;
  return surname ? 'Dr ' + surname : 'there';
}

function greeting(firstName, fullName) {
  return 'Hi ' + greetingName(firstName, fullName) + ',';
}

module.exports = { TITLES, firstNameFor, greetingName, greeting };
