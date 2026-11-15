// Vexl frontend. Plain JS, no build step.
// Laid out like MyChart (Home, Visits with After Visit Summary, Medications, Health Summary),
// using the terms clinicians already use (chief complaint, HPI, location, quality, severity, context).
// Everything shown comes from the records server; nothing is invented here.
// Patient and clinician text is untrusted, so it is only ever shown with textContent.
// Encryption lives in unlock.js (window.vexoAuth); import in import.js (window.vexoImport).
'use strict';

// ---------- config ----------
const params = new URLSearchParams(location.search);
const API = (() => { const v = params.get('api'); return v && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : ''; })();
const SHOW_MESSAGES = params.get('messages') === '1';   // off for the demo; ?messages=1 turns it on
const REFRESH_MS = 2000;                                // two open windows stay in step
const RECENT_COUNT = 3;

// route -> nav bar and selected tab
const ROUTES = {
  home:        { tab: 'home' },
  symptoms:    { tab: 'symptoms', title: 'Symptoms' },
  log:         { tab: 'symptoms', title: 'Log a Symptom', back: ['#symptoms', 'Symptoms'] },
  visits:      { tab: 'visits', title: 'Visits' },
  visit:       { tab: 'visits', title: 'After Visit Summary', back: ['#visits', 'Visits'] },
  review:      { tab: 'visits', title: 'Review Visit Note', back: ['#visits', 'Visits'] },
  medications: { tab: 'medications', title: 'Medications' },
  summary:     { tab: 'summary', title: 'Health Summary' },
  share:       { tab: 'summary', title: 'Export My Record', back: ['#summary', 'Summary'] },
  messages:    { tab: 'home', title: 'Messages', back: ['#home', 'Home'] },
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const auth = () => window.vexoAuth || null;
const present = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const cap = (s) => (present(s) ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.append(use);
  return svg;
}
function button(text, cls, onClick, iconName) {
  const b = el('button', 'btn ' + (cls || ''));
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  b.append(document.createTextNode(text));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function link(text, href, cls) { const a = el('a', cls || 'btn', text); a.href = href; return a; }
function sectionLabel(text, linkText, href) {
  const p = el('p', 'section-label', text);
  if (linkText) { const a = el('a', null, linkText); a.href = href; p.append(a); }
  return p;
}

class Locked extends Error {}
class Missing extends Error {}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), ...((auth() && auth().headers()) || {}) };
  const res = await fetch(API + path, { cache: 'no-store', ...options, headers });
  if (res.status === 401 || res.status === 403) throw new Locked(path);
  if (res.status === 404) throw new Missing(path);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

// Local ISO 8601 with the offset: the patient's own clock is clinical context.
function localIso(d = new Date()) {
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

// Times are read as written (with their own offset), not converted to this browser's zone.
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function parseTs(ts) {
  const m = TS_RE.exec(ts || '');
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: m[4] === undefined ? null : +m[4], mi: m[5] === undefined ? null : +m[5] };
}
const weekday = (p) => WD[new Date(p.y, p.mo - 1, p.d).getDay()];
const clock = (p) => (p && p.h !== null ? `${p.h % 12 || 12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}` : '');
const hhmm = (t) => { const [h, m] = String(t).split(':').map(Number); return Number.isNaN(h) ? t : clock({ h, mi: m || 0 }); };
function dayDiff(p) {
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(p.y, p.mo - 1, p.d)) / 86400000);
}
function dayName(p) {
  const diff = dayDiff(p);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  return `${weekday(p)}, ${MON[p.mo - 1]} ${p.d}`;
}
const shortDate = (p) => `${MON[p.mo - 1]} ${p.d}, ${p.y}`;
const whenText = (p) => (p ? [dayName(p), clock(p)].filter(Boolean).join(', ') : 'Time not recorded');
const fullWhen = (p) => (p ? `${weekday(p)}, ${shortDate(p)}${p.h === null ? '' : ' at ' + clock(p)}` : 'Not recorded');

function dateTile(p) {
  const t = el('div', 'datetile');
  if (!p) return t;
  t.append(el('span', 'm', MON[p.mo - 1]), el('span', 'd', p.d), el('span', 'w', weekday(p)));
  return t;
}

function sevEl(sev) {
  const n = Number(sev);
  if (!present(sev) || Number.isNaN(n)) return el('span', 'sev none', 'Not rated');
  const s = el('span', 'sev ' + (n >= 7 ? 'high' : n >= 4 ? 'mid' : 'low'), `${n}/10`);
  s.setAttribute('aria-label', `Severity ${n} out of 10`);
  return s;
}
const sevText = (sev) => (present(sev) && !Number.isNaN(Number(sev)) ? `${Number(sev)}/10` : null);
// ---------- body figure: where a symptom was reported ----------
// Front-facing figure in a 100 x 200 box. Built with DOM calls, never from patient text.
const BODY = {
  head:    { label: 'Head',    words: ['head', 'face', 'eye', 'ear', 'nose', 'mouth', 'throat', 'neck', 'jaw'], at: [50, 18] },
  chest:   { label: 'Chest',   words: ['chest', 'heart', 'lung', 'breast', 'rib'], at: [50, 58] },
  abdomen: { label: 'Abdomen', words: ['abdomen', 'stomach', 'belly', 'gut'], at: [50, 82] },
  back:    { label: 'Back',    words: ['back', 'spine'], at: [50, 68] },
  arm:     { label: 'Arm',     words: ['arm', 'elbow', 'wrist', 'hand', 'finger', 'shoulder'], at: [22.5, 74], limb: true },
  leg:     { label: 'Leg',     words: ['leg', 'knee', 'thigh', 'shin', 'calf', 'foot', 'ankle', 'toe', 'hip'], at: [41.5, 150], limb: true },
};
function regionOf(location) {
  const t = String(location || '').toLowerCase();
  if (!t) return null;
  const key = Object.keys(BODY).find((k) => BODY[k].words.some((w) => t.includes(w)));
  if (!key) return null;
  // the figure faces us: the patient's left is on our right
  return { key, side: /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : null };
}
// marks: [{ key, side, n }]; n scales the marker on the summary figure
function bodyFig(marks, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
  const svg = mk('svg', { viewBox: '0 0 100 200', class: 'bodyfig ' + (cls || ''), role: 'img' });
  const g = mk('g', { class: 'bodyfig-shape' });
  g.append(mk('circle', { cx: 50, cy: 18, r: 13 }), mk('rect', { x: 45, y: 29, width: 10, height: 10 }),
    mk('rect', { x: 30, y: 37, width: 40, height: 62, rx: 12 }),
    mk('rect', { x: 18, y: 40, width: 9, height: 62, rx: 4.5 }), mk('rect', { x: 73, y: 40, width: 9, height: 62, rx: 4.5 }),
    mk('rect', { x: 35, y: 92, width: 13, height: 104, rx: 6.5 }), mk('rect', { x: 52, y: 92, width: 13, height: 104, rx: 6.5 }));
  svg.append(g);
  const names = [];
  (marks || []).filter((m) => m && BODY[m.key]).forEach((m) => {
    const b = BODY[m.key];
    const r = m.n ? Math.min(5 + m.n * 1.2, 13) : 6.5;
    const spots = !b.limb ? [b.at] : m.side === 'left' ? [[100 - b.at[0], b.at[1]]] : m.side === 'right' ? [b.at] : [b.at, [100 - b.at[0], b.at[1]]];
    spots.forEach(([x, y]) => svg.append(mk('circle', { cx: x, cy: y, r, class: 'bodyfig-halo' }), mk('circle', { cx: x, cy: y, r: Math.max(r * 0.42, 2.6), class: 'bodyfig-dot' })));
    names.push(b.label);
  });
  svg.setAttribute('aria-label', names.length ? `Body location: ${names.join(', ')}` : 'Body location not stated');
  return svg;
}
function symptomFig(e, cls) { const r = regionOf(e.body_location); return bodyFig(r ? [{ ...r, n: cls === 'fig-row' ? 5 : 2 }] : [], cls); }

function symptomTitle(e) {
  if (present(e.quality) && present(e.body_location)) return `${cap(e.quality)}, ${e.body_location}`;
  return cap(e.quality) || cap(e.body_location) || 'Symptom';
}
const sourceText = (e) => (e.source === 'band' ? `Spoken on band${Number(e.audio_seconds) > 0 ? ` (${Number(e.audio_seconds).toFixed(0)} s)` : ''}` : e.source === 'manual' ? 'Typed in app' : (e.source || 'Unknown'));
const newestFirst = (a, b) => String(b.ts || '').localeCompare(String(a.ts || ''));
const doseTime = (d) => String(d.taken_at || d.ts || '');

// Same rule as intake_form() in records_server.py, so local and vault modes agree.
function intakeForm(events) {
  if (!events.length) return null;
  const score = (e) => [e.severity !== null && e.severity !== undefined, !!e.body_location, !!e.activity, e.ts || ''];
  const cmp = (a, b) => { for (let i = 0; i < 4; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
  return events.reduce((best, e) => (cmp(score(e), score(best)) > 0 ? e : best));
}

function nextDose(meds) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  let best = null;
  meds.filter((m) => m.confirmed_at).forEach((m) => (m.times || []).forEach((t) => {
    const [h, mi] = String(t).split(':').map(Number);
    if (Number.isNaN(h)) return;
    const at = h * 60 + (mi || 0);
    if (at >= mins && (!best || at < best.at)) best = { at, t, med: m };
  }));
  return best;
}
function sig(m) {
  const times = (m.times || []).map(hhmm);
  const parts = [];
  if (times.length) parts.push(`Take at ${times.join(' and ')}`);
  if (present(m.instructions)) parts.push(m.instructions);
  return parts.join(', ') + (parts.length ? '.' : '');
}

// ---------- state ----------
const state = {
  events: [], visits: [], drafts: [], meds: [], doses: [], msgs: [],
  have: { visits: false, meds: false, doses: false, msgs: false },
  locked: false, online: null,
  filter: { q: '', src: 'all', loc: '' },
  visitsTab: 'upcoming',
  reviewed: false, reviewKey: '',
  seen: null,
};

// ---------- data ----------
async function load(path) {
  try {
    const raw = await api(path);
    const rows = Array.isArray(raw) ? raw : [];
    const a = auth();
    const items = a ? await a.decryptRows(rows) : rows.filter((r) => r.sealed !== true);
    return { items, sealedLeft: rows.some((r) => r.sealed === true) && !(a && a.isUnlocked()) };
  } catch (err) {
    if (err instanceof Missing) return { items: [], missing: true };
    if (err instanceof Locked) return { items: [], locked: true };
    throw err;
  }
}

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const none = Promise.resolve({ items: [], missing: true });
    const [obs, enc, med, adm, msg] = await Promise.all([
      load('/Observation'), load('/Encounter'), load('/MedicationRequest'), load('/MedicationAdministration'),
      SHOW_MESSAGES ? load('/Communication') : none,
    ]);
    state.events = obs.items;
    // a recorded visit is only an After Visit Summary once the clinician approves it
    state.visits = enc.items.filter((v) => !v.status || v.status === 'final');
    state.drafts = enc.items.filter((v) => v.status === 'draft' || v.status === 'recording');
    state.have.visits = !enc.missing;
    state.meds = med.items; state.have.meds = !med.missing;
    state.doses = adm.items; state.have.doses = !adm.missing;
    state.msgs = msg.items; state.have.msgs = !msg.missing;
    state.locked = [obs, enc, med, adm, msg].some((r) => r.locked || r.sealedLeft);
    state.online = true;
  } catch (_) {
    state.online = false;
  } finally {
    busy = false;
  }
  renderAll();
}

// other windows of this app (same browser) refresh at once after a save
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('symptom-log') : null;
if (channel) channel.onmessage = () => refresh();
const announce = () => { if (channel) channel.postMessage('changed'); };

async function post(path, obj) {
  const a = auth();
  const body = a && a.isUnlocked() ? await a.sealEvent(obj) : obj;
  const r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  announce();
  return r;
}

// ---------- shared pieces ----------
function emptyBox(title, body) {
  const d = el('div', 'empty');
  d.append(el('b', null, title), document.createTextNode(body));
  return d;
}
function kv(pairs) {
  const dl = el('dl', 'kv');
  pairs.forEach(([k, v, cls]) => {
    const has = present(v);
    dl.append(el('dt', null, k), el('dd', has ? (cls || '') : 'muted', has ? v : 'Not reported'));
  });
  return dl;
}

// ---------- sheet ----------
let lastFocus = null;
function openSheet(title, build) {
  lastFocus = document.activeElement;
  $('sheet-title').textContent = title;
  const body = $('sheet-body');
  body.replaceChildren();
  build(body);
  $('sheet').hidden = false; $('sheet-backdrop').hidden = false;
  $('sheet-close').focus();
}
function closeSheet() { $('sheet').hidden = true; $('sheet-backdrop').hidden = true; if (lastFocus) lastFocus.focus(); }
$('sheet-close').addEventListener('click', closeSheet);
$('sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

function symptomSheet(e) {
  openSheet('Symptom', (b) => {
    const g = el('div', 'group');
    g.append(kv([
      ['Onset', fullWhen(parseTs(e.ts))],
      ['Location', e.body_location],
      ['Quality', e.quality],
      ['Severity', sevText(e.severity)],
      ['Context', e.activity],
    ]));
    const hp = el('div', 'hpi-with-fig'); hp.append(symptomFig(e, 'fig-sheet'), g);
    b.append(sectionLabel('History of Present Illness'), hp);
    if (present(e.verbatim_quote)) {
      const q = el('div', 'group'); q.append(el('p', 'prose quote', `“${e.verbatim_quote}”`));
      b.append(sectionLabel('Patient Statement'), q);
    }
    const s = el('div', 'group');
    s.append(kv([
      ['Source', sourceText(e)],
      ['Transcribed by', e.transcript_model],
      ['Structured by', e.extract_model],
    ]));
    b.append(sectionLabel('Record'), s);
    b.append(el('p', 'footnote', 'Patient-reported. Not a diagnosis. Fields are filled only from what the patient said.'));
  });
}

// ---------- rows ----------
function symptomRow(e, isNew) {
  const r = el('button', 'row row-link' + (isNew ? ' new' : ''));
  r.type = 'button';
  const p = parseTs(e.ts);
  r.append(el('span', 'time-col', p ? clock(p) || '–' : '–'), symptomFig(e, 'fig-row'));
  const m = el('span', 'row-main');
  m.append(el('span', 'row-title', symptomTitle(e)));
  const sub = [e.activity ? cap(e.activity) : null, present(e.verbatim_quote) ? `“${e.verbatim_quote}”` : null].filter(Boolean).join(' · ');
  if (sub) m.append(el('span', 'row-sub', sub));
  r.append(m, sevEl(e.severity), icon('chev', 'chev'));
  r.addEventListener('click', () => symptomSheet(e));
  return r;
}

function visitRow(v, opts = {}) {
  const r = el(opts.link === false ? 'div' : 'a', 'visit-row' + (opts.link === false ? '' : ' row-link'));
  if (opts.link !== false) r.href = '#visit/' + encodeURIComponent(v.id);
  const p = parseTs(opts.date || v.ts);
  r.append(dateTile(p));
  const m = el('div', 'row-main');
  m.append(el('span', 'row-title', opts.title || (v.kind === 'video' ? 'Video Visit' : 'Office Visit')));
  const lines = el('div', 'visit-lines');
  const ln = (ic, text) => { if (!present(text)) return; const d = el('div', 'ln'); d.append(icon(ic), el('span', null, text)); lines.append(d); };
  ln('clock', p && p.h !== null ? clock(p) : (opts.date ? 'Time to be scheduled' : null));
  ln('person', [v.clinician, v.specialty].filter(present).join(', '));
  ln('symptom', opts.title ? null : v.reason);
  m.append(lines);
  r.append(m);
  if (opts.link !== false) r.append(icon('chev', 'chev'));
  return r;
}

function medRow(m) {
  const d = el('div', 'med');
  d.append(el('p', 'med-name', [m.name, m.dose].filter(present).join(' ') || 'Medication'));
  const s = sig(m);
  if (s) d.append(el('p', 'med-sig', s));
  const meta = [m.prescribed_by ? `Prescribed by ${m.prescribed_by}` : null, m.start ? `Started ${shortDate(parseTs(m.start))}` : null,
    m.end ? `Ends ${shortDate(parseTs(m.end))}` : null].filter(Boolean).join(' · ');
  if (meta) d.append(el('p', 'med-meta', meta));

  const taken = state.doses.filter((x) => x.medication_id === m.id).sort((a, b) => doseTime(b).localeCompare(doseTime(a)));
  if (taken.length) {
    const t = el('div', 'taken');
    taken.slice(0, 3).forEach((x) => {
      const line = el('div', 'taken-line');
      line.append(icon(x.method === 'voice' ? 'mic' : 'check'), el('span', null, 'Taken '), el('b', null, whenText(parseTs(doseTime(x)))),
        el('span', null, x.method === 'voice' ? ' · said on band' : ' · logged in app'));
      if (present(x.verbatim_quote)) line.title = `“${x.verbatim_quote}”`;
      t.append(line);
    });
    d.append(t);
  }

  const foot = el('div', 'med-foot');
  if (m.confirmed_at) {
    const f = el('span', 'med-flag ok'); f.append(icon('check'), document.createTextNode(m.confirmed_by === 'clinician' ? 'Reviewed by clinician' : 'Reviewed by you'));
    foot.append(f);
  } else {
    const f = el('span', 'med-flag todo'); f.append(icon('todo'), document.createTextNode('Not yet reviewed'));
    const b = button('Mark as Reviewed', 'btn-primary btn-sm');
    b.addEventListener('click', () => confirmMed(m, b));
    foot.append(f, b);
  }
  if (m.confirmed_at && state.have.doses) {
    const b = button('Mark as Taken', 'btn-sm', null, 'check');
    b.addEventListener('click', () => logDose(m, b));
    foot.append(b);
  }
  d.append(foot);
  return d;
}

async function confirmMed(m, b) {
  b.disabled = true;
  try { await post('/MedicationRequest', { ...m, confirmed_at: localIso(), confirmed_by: 'patient' }); refresh(); }
  catch (err) { b.disabled = false; b.textContent = 'Try again'; }
}
async function logDose(m, b) {
  b.disabled = true;
  const now = localIso();
  try {
    await post('/MedicationAdministration', { id: 'adm-' + Date.now(), ts: now, taken_at: now, schema_version: '0.1', medication_id: m.id, medication_name: m.name || null, dose_taken: m.dose || null, method: 'manual', verbatim_quote: null });
    refresh();
  } catch (err) { b.disabled = false; b.lastChild.textContent = 'Try again'; }
}

// ---------- screens ----------
function renderHome(sorted) {
  // To Do, like MyChart's to-do list
  const todo = [];
  const toReview = state.meds.filter((m) => !m.confirmed_at);
  state.drafts.filter((v) => v.status === 'draft').forEach((v) => todo.push(['doc', 'Approve visit note', [v.clinician, shortDate(parseTs(v.ts))].filter(present).join(', '), '#review/' + encodeURIComponent(v.id)]));
  if (toReview.length) todo.push(['med', 'Review your medication list', `${toReview.length} new from your last visit`, '#medications']);
  const lv = pastVisits()[0];
  if (lv && dayDiff(parseTs(lv.ts) || { y: 1970, mo: 1, d: 1 }) <= 7) todo.push(['doc', 'Read your After Visit Summary', `${lv.clinician || 'Your visit'}, ${dayName(parseTs(lv.ts))}`, '#visit/' + encodeURIComponent(lv.id)]);
  const box = $('home-todo');
  box.replaceChildren();
  if (todo.length) {
    const c = el('div', 'card');
    const h = el('div', 'card-head'); h.append(icon('todo'), document.createTextNode('To Do'));
    c.append(h);
    const list = el('div');
    list.style.marginTop = '6px';
    todo.forEach(([ic, title, sub, href]) => {
      const a = el('a', 'todo row-link'); a.href = href;
      a.append(icon(ic));
      const m = el('span', 'row-main'); m.append(el('span', 'row-title', title), el('span', 'row-sub', sub));
      a.append(m, icon('chev', 'chev'));
      list.append(a);
    });
    c.append(list);
    box.append(c);
  }

  // Upcoming visit (follow-up), else last visit
  const vbox = $('home-visit');
  vbox.replaceChildren();
  const up = upcoming()[0];
  const show = up || (lv ? { v: lv } : null);
  if (show) {
    // glass card sitting in the header gradient
    const c = el('div', 'hero-card');
    const h = el('div', 'hero-card-head');
    h.append(el('span', null, up ? 'Upcoming Visits' : 'Past Visits'));
    const all = el('a', null, 'All Visits'); all.href = '#visits'; h.append(all);
    c.append(h, up ? visitRow(up.v, { date: up.date, title: up.title, link: false }) : visitRow(lv, { link: false }));
    const acts = el('div', 'hero-card-actions');
    acts.append(up && up.scheduled ? link('View Visits', '#visits', 'btn btn-light btn-sm') : link('View After Visit Summary', '#visit/' + encodeURIComponent((up ? up.v : lv).id), 'btn btn-light btn-sm'));
    c.append(acts);
    vbox.append(c);
  }

  // one line under the greeting, from real counts
  const week = sorted.filter((e) => { const p = parseTs(e.ts); return p && dayDiff(p) < 7; }).length;
  const line = [];
  if (state.locked) line.push('Loading your records');
  else {
    line.push(`${week} symptom${week === 1 ? '' : 's'} logged this week`);
    if (toReview.length) line.push(`${toReview.length} medication${toReview.length === 1 ? '' : 's'} to review`);
  }
  $('home-line').textContent = ['Band 29', ...line].join(' · ');

  // at a glance: next dose and latest symptom
  const gl = $('home-glance');
  gl.replaceChildren();
  const nd = nextDose(state.meds);
  const latest = sorted[0];
  const glanceCard = (hue, iconName, label, value, sub, href, valueEl) => {
    const a = el('a', 'glance-card'); a.href = href; a.dataset.hue = hue;
    const top = el('span', 'glance-top'); const ic = el('span', 'glance-ico'); ic.append(icon(iconName)); top.append(ic, el('span', 'glance-label', label));
    a.append(top, valueEl || el('span', 'glance-value', value), el('span', 'glance-sub', sub));
    return a;
  };
  if (nd) gl.append(glanceCard('amber', 'med', 'Next dose', hhmm(nd.t), [nd.med.name, nd.med.dose].filter(present).join(' '), '#medications'));
  else if (state.meds.length) gl.append(glanceCard('amber', 'med', 'Medications', `${state.meds.length}`, toReview.length ? `${toReview.length} to review` : 'No more doses today', '#medications'));
  if (latest) {
    const v = sevEl(latest.severity); v.className += ' glance-value';
    gl.append(glanceCard('rose', 'symptom', 'Latest symptom', '', `${symptomTitle(latest)} · ${whenText(parseTs(latest.ts))}`, '#symptoms', v));
  }
  gl.hidden = !gl.childElementCount;

  // Recent symptoms
  const sbox = $('home-symptoms');
  sbox.replaceChildren();
  const c = el('div', 'card');
  const h = el('div', 'card-head'); h.append(icon('symptom'), document.createTextNode('Recent Symptoms'));
  const all = el('a', null, 'View all'); all.href = '#symptoms'; h.append(all);
  c.append(h);
  const g = el('div', 'group'); g.style.marginTop = '4px';
  const isNew = (e) => state.seen !== null && !state.seen.has(e.id);
  if (sorted.length) sorted.slice(0, RECENT_COUNT).forEach((e) => g.append(symptomRow(e, isNew(e))));
  else g.append(emptyBox('No symptoms logged', 'Tap your band and describe what you feel, or use Log a Symptom.'));
  c.append(g);
  sbox.append(c);
}

function filteredSymptoms() {
  const q = state.filter.q.trim().toLowerCase();
  return state.events.filter((e) => {
    if (state.filter.src !== 'all' && e.source !== state.filter.src) return false;
    if (state.filter.loc && String(e.body_location || '').toLowerCase() !== state.filter.loc) return false;
    if (!q) return true;
    return [e.verbatim_quote, e.body_location, e.quality, e.activity].some((v) => String(v || '').toLowerCase().includes(q));
  }).sort(newestFirst);
}

function renderSymptoms() {
  const locs = [...new Set(state.events.map((e) => String(e.body_location || '').toLowerCase()).filter(Boolean))].sort();
  const f = $('filters');
  f.replaceChildren(...locs.map((l) => {
    const b = el('button', null, l); b.type = 'button'; b.dataset.loc = l;
    b.setAttribute('aria-pressed', String(state.filter.loc === l));
    return b;
  }));
  f.hidden = !locs.length;

  const rows = filteredSymptoms();
  const out = [];
  const isNew = (e) => state.seen !== null && !state.seen.has(e.id);
  let day = null, group = null;
  rows.forEach((e) => {
    const p = parseTs(e.ts);
    const key = p ? `${p.y}-${p.mo}-${p.d}` : 'none';
    if (key !== day) {
      day = key;
      const n = rows.filter((x) => { const q = parseTs(x.ts); return (q ? `${q.y}-${q.mo}-${q.d}` : 'none') === key; }).length;
      out.push(sectionLabel(p ? `${dayName(p)}${dayDiff(p) <= 1 ? ' · ' + shortDate(p) : ''}` : 'No date', `${n} logged`, null));
      group = el('div', 'group');
      out.push(group);
    }
    group.append(symptomRow(e, isNew(e)));
  });
  out.forEach((n) => { const a = n.querySelector && n.querySelector('a:not([href])'); if (a) a.replaceWith(el('span', 'row-meta', a.textContent)); });
  if (!rows.length) {
    const g = el('div', 'group'); g.style.marginTop = '14px';
    g.append(state.events.length ? emptyBox('No matches', 'Try another word or filter.')
      : emptyBox('No symptoms logged', 'Symptoms you log on the band or here appear by day, newest first.'));
    out.push(g);
  }
  $('symptom-groups').replaceChildren(...out);
}

// a visit dated after now is scheduled, not past
function isFuture(ts) {
  const p = parseTs(ts);
  if (!p) return false;
  const d = new Date(p.y, p.mo - 1, p.d, p.h === null ? 23 : p.h, p.mi === null ? 59 : p.mi);
  return d > new Date();
}
function pastVisits() { return state.visits.filter((v) => !isFuture(v.ts)).sort(newestFirst); }

// upcoming: visits scheduled in the future, plus follow-ups asked for at past visits
function upcoming() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sched = state.visits.filter((v) => isFuture(v.ts)).map((v) => ({ v, date: v.ts, p: parseTs(v.ts), title: v.reason || 'Scheduled Visit', scheduled: true }));
  const follow = pastVisits().filter((v) => present(v.follow_up)).map((v) => ({ v, date: v.follow_up, p: parseTs(v.follow_up), title: 'Follow-up Visit' }))
    .filter((x) => x.p && new Date(x.p.y, x.p.mo - 1, x.p.d) >= today);
  return sched.concat(follow).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function renderVisits() {
  const waiting = draftGroup();
  document.querySelectorAll('#seg-visits [data-v]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === state.visitsTab)));
  const out = [];
  if (state.visitsTab === 'upcoming') {
    const ups = upcoming();
    if (ups.length) {
      const g = el('div', 'group');
      ups.forEach((u) => {
        const row = visitRow(u.v, { date: u.date, title: u.title, link: !u.scheduled });
        g.append(row);
      });
      out.push(sectionLabel('Upcoming Visits'), g);
    } else {
      const g = el('div', 'group'); g.style.marginTop = '14px';
      g.append(emptyBox('No upcoming visits', 'Follow-up visits your doctor asks for appear here.'));
      out.push(g);
    }
  } else {
    const past = pastVisits();
    if (past.length) {
      const g = el('div', 'group');
      past.forEach((v) => g.append(visitRow(v)));
      out.push(sectionLabel('Past Visits'), g);
    } else {
      const g = el('div', 'group'); g.style.marginTop = '14px';
      g.append(emptyBox('No past visits', state.have.visits ? 'After a visit, its After Visit Summary appears here.' : 'Visits appear here once your records server supports them.'));
      out.push(g);
    }
  }
  $('visit-list').replaceChildren(...waiting, ...out);
}

function renderVisit(id) {
  const v = state.visits.find((x) => x.id === id);
  const box = $('avs');
  if (!v) {
    const g = el('div', 'group'); g.style.marginTop = '14px';
    g.append(emptyBox('Visit not found', 'It may have been removed, or is still loading.'));
    box.replaceChildren(g);
    return;
  }
  const out = [];
  const p = parseTs(v.ts);
  const head = el('div', 'group');
  const hr = el('div', 'avs-head');
  hr.append(dateTile(p));
  const hm = el('div', 'row-main');
  hm.append(el('span', 'row-title', v.kind === 'video' ? 'Video Visit' : 'Office Visit'));
  hm.append(el('span', 'row-sub', [v.clinician, v.specialty].filter(present).join(', ')));
  hm.append(el('span', 'row-meta', fullWhen(p)));
  hr.append(hm);
  head.append(hr);
  out.push(head);

  if (present(v.reason)) { const g = el('div', 'group'); g.append(el('p', 'prose', v.reason)); out.push(sectionLabel('Reason for Visit'), g); }
  const s = el('div', 'group');
  s.append(present(v.summary) ? el('p', 'prose', v.summary) : emptyBox('Not added yet', 'Your clinician has not added notes yet.'));
  out.push(sectionLabel('Visit Notes'), s);

  const steps = (v.instructions || []).filter(present);
  if (steps.length) {
    const g = el('div', 'group'); const ol = el('ol', 'ol');
    steps.forEach((t, i) => { const li = el('li'); li.append(el('span', 'n', `${i + 1}.`), el('span', null, t)); ol.append(li); });
    g.append(ol); out.push(sectionLabel('Instructions'), g);
  }
  const tests = (v.tests_ordered || []).filter(present);
  if (tests.length) {
    const g = el('div', 'group'); const ol = el('ol', 'ol');
    tests.forEach((t, i) => { const li = el('li'); li.append(el('span', 'n', `${i + 1}.`), el('span', null, t)); ol.append(li); });
    g.append(ol); out.push(sectionLabel('Tests Ordered'), g);
  }
  const meds = state.meds.filter((m) => m.visit_id === v.id || (v.medication_ids || []).includes(m.id));
  if (meds.length) {
    const g = el('div', 'group');
    meds.forEach((m) => g.append(medRow(m)));
    out.push(sectionLabel('New Medications', 'Medications', '#medications'), g);
  }
  if (present(v.follow_up)) {
    const g = el('div', 'group');
    g.append(visitRow(v, { date: v.follow_up, title: 'Follow-up Visit', link: false }));
    out.push(sectionLabel("What's Next"), g);
  }
  const related = state.events.filter((e) => (v.related_event_ids || []).includes(e.id)).sort(newestFirst);
  if (related.length) {
    const g = el('div', 'group');
    related.forEach((e) => g.append(symptomRow(e, false)));
    out.push(sectionLabel('Symptoms Discussed'), g);
  }
  out.push(el('p', 'footnote', `${v.approved_by ? 'Approved by ' + v.approved_by + '. ' : ''}${v.source ? 'Source: ' + v.source + '. ' : ''}This summary is not part of your hospital's legal medical record.`));
  box.replaceChildren(...out);
}

// ---------- clinician review: a recorded visit is saved only after approval ----------
// The band records the visit between "I'm with the doctor" and "the meeting is done";
// a local model drafts the note. Nothing reaches the patient's record until the
// clinician checks it here and approves it.
function draftGroup() {
  if (!state.drafts.length) return [];
  const g = el('div', 'group');
  [...state.drafts].sort(newestFirst).forEach((v) => {
    const p = parseTs(v.ts);
    const rec = v.status === 'recording';
    const r = el(rec ? 'div' : 'a', 'row' + (rec ? '' : ' row-link'));
    if (!rec) r.href = '#review/' + encodeURIComponent(v.id);
    const i = el('span', 'row-ico'); i.append(icon(rec ? 'mic' : 'doc'));
    const m = el('span', 'row-main');
    m.append(el('span', 'row-title', rec ? 'Recording visit' : 'Visit note to approve'),
      el('span', 'row-sub', rec ? `Started ${p ? clockText(p) : ''} · say “the meeting is done” to finish` : [v.clinician, p ? `${shortDate(p)}, ${clockText(p)}` : null].filter(present).join(' · ')));
    r.append(i, m);
    if (!rec) r.append(el('span', 'row-meta warn', 'Review'), icon('chev', 'chev'));
    g.append(r);
  });
  return [sectionLabel('Waiting for Approval'), g];
}
function clockText(p) { return p && p.h !== null ? clock(p) : ''; }

let reviewStamp = '';
function renderReview(id, force) {
  const v = state.drafts.find((x) => x.id === id);
  const stamp = v ? `${v.id}|${v.status}` : `gone|${id}|${state.visits.some((x) => x.id === id)}`;
  if (stamp === reviewStamp && !force) return;   // keep the clinician's edits while the app polls
  reviewStamp = stamp;
  const box = $('review');
  if (!v) {
    const g = el('div', 'group'); g.style.marginTop = '14px';
    const done = state.visits.find((x) => x.id === id);
    g.append(emptyBox(done ? 'Already approved' : 'Visit note not found', done ? 'This visit is in the After Visit Summary.' : 'It may still be loading.'));
    if (done) { const a = link('Open After Visit Summary', '#visit/' + encodeURIComponent(id), 'btn btn-primary btn-sm'); a.style.margin = '0 14px 14px'; g.append(a); }
    box.replaceChildren(g);
    return;
  }
  const p = parseTs(v.ts);
  const head = el('div', 'group');
  const hr = el('div', 'avs-head');
  hr.append(dateTile(p));
  const hm = el('div', 'row-main');
  hm.append(el('span', 'row-title', v.status === 'recording' ? 'Recording visit' : 'Visit Note · Draft'));
  const end = parseTs(v.end);
  hm.append(el('span', 'row-sub', [v.clinician, v.specialty].filter(present).join(', ') || 'Clinician not stated'));
  hm.append(el('span', 'row-meta', [fullWhen(p), end ? `to ${clockText(end)}` : null].filter(Boolean).join(' ')));
  hr.append(hm);
  head.append(hr);
  if (v.status === 'recording') {
    const g = el('div', 'group');
    g.append(emptyBox('The band is recording this visit', 'When the visit ends, say “the meeting is done”. The draft note appears here for review.'));
    box.replaceChildren(head, g);
    return;
  }

  const n = v.note || {};
  const fields = {};
  const lines = (a) => (a || []).filter(present).join('\n');
  const input = (key, value, multi, ph) => {
    const f = el(multi ? 'textarea' : 'input', 'note-in');
    f.value = value == null ? '' : String(value);
    if (ph) f.placeholder = ph;
    if (multi) { f.rows = Math.max(2, Math.ceil(f.value.length / 80) + (f.value.match(/\n/g) || []).length); }
    fields[key] = f;
    return f;
  };
  const table = el('table', 'note-table');
  const row = (label, ...cells) => { const tr = el('tr'); const th = el('th', null, label); th.scope = 'row'; const td = el('td'); td.append(...cells); tr.append(th, td); table.append(tr); };
  row('Clinician', input('clinician', v.clinician, false, 'Name'));
  row('Specialty', input('specialty', v.specialty, false, 'Not stated'));
  row('Chief Complaint', input('reason', v.reason, false, 'Not stated'));
  row('Subjective', input('subjective', n.subjective, true, 'History of present illness'));
  row('Objective', input('objective', n.objective, true, 'Exam, vitals, results'));
  row('Assessment', input('assessment', n.assessment, true, 'Not stated in the visit'));
  row('Plan', input('plan', n.plan, true, 'Not stated'));

  // medications: one row each, added as unreviewed prescriptions for the patient to confirm
  const medBody = el('tbody');
  const medRowEl = (m = {}) => {
    const tr = el('tr');
    ['name', 'dose', 'frequency', 'times'].forEach((k) => {
      const td = el('td'); const f = el('input', 'note-in'); f.dataset.k = k;
      f.value = k === 'times' ? (m.times || []).join(', ') : (m[k] || '');
      f.placeholder = { name: 'Medication', dose: 'Dose', frequency: 'How often', times: 'e.g. 08:00' }[k];
      f.setAttribute('aria-label', f.placeholder);
      td.append(f); tr.append(td);
    });
    medBody.append(tr);
  };
  (v.medications || []).forEach(medRowEl);
  const medTable = el('table', 'note-meds');
  const mh = el('tr'); ['Name', 'Dose', 'How often', 'Times'].forEach((t) => mh.append(el('th', null, t)));
  const thead = el('thead'); thead.append(mh);
  medTable.append(thead, medBody);
  const addMed = button('Add medication', 'btn-plain btn-sm', () => medRowEl());
  row('Medications', medTable, addMed);
  row('Tests Ordered', input('tests', lines(v.tests_ordered), true, 'One per line'));
  const fu = el('div', 'note-fu');
  const fuDate = el('input', 'note-in'); fuDate.type = 'date'; fuDate.setAttribute('aria-label', 'Follow-up date');
  if (present(v.follow_up)) fuDate.value = String(v.follow_up).slice(0, 10);
  fields.followDate = fuDate;
  fu.append(fuDate);
  if (present(v.follow_up_text)) fu.append(el('span', 'note-said', `Said: “${v.follow_up_text}”`));
  row('Follow-up', fu);
  row('Patient Instructions', input('instructions', lines(v.instructions), true, 'One per line'));
  row('Summary for Patient', input('summary', v.summary, true, 'Plain language'));
  const tg = el('div', 'group note-wrap'); tg.append(table);

  const out = [head, sectionLabel('Visit Note'), tg];
  if (present(v.transcript)) {
    const d = el('details', 'group transcript');
    d.append(el('summary', null, 'Transcript of the visit'), el('p', 'prose', v.transcript));
    out.push(d);
  }
  const acts = el('div', 'note-actions');
  const ok = button('Approve and Save', 'btn-primary', null, 'check');
  ok.addEventListener('click', () => approveVisit(v, fields, medBody, ok));
  acts.append(ok);
  out.push(acts, el('p', 'footnote', `Drafted by ${v.note_model || 'a local model'} from the recording. Check each line against the transcript. Nothing is added to the patient's record until you approve.`));
  box.replaceChildren(...out);
}

async function approveVisit(v, f, medBody, b) {
  b.disabled = true;
  const val = (k) => f[k].value.trim() || null;
  const list = (k) => f[k].value.split('\n').map((x) => x.trim()).filter(Boolean);
  const clinician = val('clinician');
  const meds = [...medBody.querySelectorAll('tr')].map((tr) => {
    const m = {}; tr.querySelectorAll('input').forEach((i) => { m[i.dataset.k] = i.value.trim(); });
    return m;
  }).filter((m) => m.name);
  try {
    // prescriptions first: if one fails, the draft stays as it is
    const ids = [];
    for (const [i, m] of meds.entries()) {
      const id = `med-${Date.now()}-${i}`;
      await post('/MedicationRequest', {
        schema_version: '0.1', id, ts: localIso(), name: m.name, dose: m.dose || null,
        times: m.times.split(/[ ,]+/).filter((t) => /^\d{1,2}:\d{2}$/.test(t)), instructions: m.frequency || null,
        prescribed_by: clinician, visit_id: v.id, start: localIso().slice(0, 10), end: null, confirmed_at: null, confirmed_by: null,
      });
      ids.push(id);
    }
    await post('/Encounter', {
      ...v, status: 'final', clinician, specialty: val('specialty'), reason: val('reason'),
      note: { subjective: val('subjective'), objective: val('objective'), assessment: val('assessment'), plan: val('plan') },
      medications: meds, medication_ids: ids, tests_ordered: list('tests'), instructions: list('instructions'),
      follow_up: f.followDate.value || null, summary: val('summary'),
      approved_at: localIso(), approved_by: clinician || 'Clinician',
    });
    await refresh();
    location.hash = '#visit/' + encodeURIComponent(v.id);
  } catch (err) {
    b.disabled = false; b.lastChild.textContent = 'Could not save. Try again';
  }
}

function renderMeds() {
  const toReview = state.meds.filter((m) => !m.confirmed_at);
  const t = $('med-todo');
  t.replaceChildren();
  if (toReview.length) {
    const c = el('div', 'locked');
    c.append(icon('todo'));
    const m = el('div', 'row-main');
    m.append(el('span', 'row-title', 'Review your medication list'), el('span', 'row-sub', 'Check each medication, dose and time, then mark it as reviewed.'));
    c.append(m);
    t.append(c);
  }
  const out = [];
  const meds = [...state.meds].sort((a, b) => (a.confirmed_at ? 1 : 0) - (b.confirmed_at ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  if (meds.length) {
    const g = el('div', 'group');
    meds.forEach((m) => g.append(medRow(m)));
    out.push(sectionLabel('Current Medications', `${meds.length}`, null), g);
  } else {
    const g = el('div', 'group'); g.style.marginTop = '14px';
    g.append(emptyBox('No medications on file', 'Medications your clinician prescribes appear here for you to review.'));
    out.push(g);
  }
  const known = new Set(state.meds.map((m) => m.id));
  const loose = state.doses.filter((d) => !d.medication_id || !known.has(d.medication_id)).sort((a, b) => doseTime(b).localeCompare(doseTime(a)));
  if (loose.length) {
    const g = el('div', 'group');
    loose.slice(0, 5).forEach((d) => {
      const r = el('div', 'row');
      const m = el('span', 'row-main');
      m.append(el('span', 'row-title', cap(d.medication_name) || 'Unnamed medication'), el('span', 'row-sub', present(d.verbatim_quote) ? `“${d.verbatim_quote}”` : 'Said on band'));
      r.append(m, el('span', 'row-meta', whenText(parseTs(doseTime(d)))));
      g.append(r);
    });
    out.push(sectionLabel('Doses Not Matched to a Medication'), g);
  }
  out.forEach((n) => { const a = n.querySelector && n.querySelector('a:not([href])'); if (a) a.replaceWith(el('span', 'row-meta', a.textContent)); });
  $('med-list').replaceChildren(...out);
  const badge = $('med-badge');
  badge.hidden = !toReview.length; badge.textContent = toReview.length;
}

function renderSummary() {
  const out = [];
  const main = intakeForm(state.events);
  const key = JSON.stringify(main);
  if (state.reviewKey && key !== state.reviewKey) state.reviewed = false;   // a new draft needs a new review
  state.reviewKey = key;


  // Chief complaint + HPI, the way a clinician reads an intake
  const cc = el('div', 'group');
  cc.append(el('p', 'prose', main ? symptomTitle(main) : 'No symptoms reported yet.'));
  const reviewBtn = el('a', null, state.reviewed ? 'Undo' : 'Mark as Reviewed');
  reviewBtn.href = '#summary';
  reviewBtn.addEventListener('click', (ev) => { ev.preventDefault(); state.reviewed = !state.reviewed; renderSummary(); });
  const ccLabel = sectionLabel('Chief Complaint');
  if (main) ccLabel.append(reviewBtn);
  out.push(ccLabel, cc);

  if (main) {
    const same = state.events.filter((e) => String(e.body_location || '').toLowerCase() === String(main.body_location || '').toLowerCase() && present(main.body_location));
    const first = [...same].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))[0] || main;
    const hpi = el('div', 'group');
    hpi.append(kv([
      ['Onset', fullWhen(parseTs(first.ts))],
      ['Location', main.body_location],
      ['Quality', main.quality],
      ['Severity', sevText(main.severity)],
      ['Context', main.activity],
      ['Frequency', same.length > 1 ? `${same.length} reports since ${dayName(parseTs(first.ts))}` : null],
      ['Patient Statement', present(main.verbatim_quote) ? `“${main.verbatim_quote}”` : null, 'quote'],
    ]));
    out.push(sectionLabel('History of Present Illness'), hpi);
    const st = el('p', 'status-line' + (state.reviewed ? ' ok' : ''));
    st.append(icon(state.reviewed ? 'check' : 'clock'), document.createTextNode(state.reviewed ? 'Reviewed by clinician (marked in this browser)' : 'Patient-reported, not yet reviewed by a clinician'));
    out.push(st);
  }

  // Current medications
  const mg = el('div', 'group');
  if (state.meds.length) {
    state.meds.forEach((m) => {
      const r = el('a', 'row row-link'); r.href = '#medications';
      const mm = el('span', 'row-main');
      mm.append(el('span', 'row-title', [m.name, m.dose].filter(present).join(' ')), el('span', 'row-sub', sig(m) || '—'));
      r.append(mm, el('span', 'row-meta', m.confirmed_at ? 'Reviewed' : 'To review'), icon('chev', 'chev'));
      mg.append(r);
    });
  } else mg.append(emptyBox('None on file', 'Prescriptions from your visits appear here.'));
  out.push(sectionLabel('Medications', 'Details', '#medications'), mg);

  // Recent visits
  const vg = el('div', 'group');
  const past = pastVisits().slice(0, 3);
  if (past.length) past.forEach((v) => vg.append(visitRow(v)));
  else vg.append(emptyBox('No visits yet', 'Visits and their summaries appear here.'));
  out.push(sectionLabel('Past Visits', 'All Visits', '#visits'), vg);

  // Patient-reported symptoms, counted by location
  const sg = el('div', 'group');
  const byLoc = {};
  state.events.forEach((e) => { const k = e.body_location ? cap(e.body_location) : 'Location not stated'; byLoc[k] = (byLoc[k] || []).concat(e); });
  const entries = Object.entries(byLoc).sort((a, b) => b[1].length - a[1].length);
  if (entries.length) {
    entries.forEach(([loc, list]) => {
      const last = [...list].sort(newestFirst)[0];
      const maxSev = Math.max(...list.map((e) => (present(e.severity) ? Number(e.severity) : -1)));
      const r = el('a', 'row row-link'); r.href = '#symptoms';
      const mm = el('span', 'row-main');
      mm.append(el('span', 'row-title', loc), el('span', 'row-sub', `${list.length} report${list.length > 1 ? 's' : ''} · last ${whenText(parseTs(last.ts))}`));
      r.append(mm, maxSev >= 0 ? sevEl(maxSev) : sevEl(null), icon('chev', 'chev'));
      sg.append(r);
    });
  } else sg.append(emptyBox('None reported', 'Symptoms you log appear here, grouped by location.'));
  out.push(sectionLabel('Patient-Reported Symptoms', 'Symptoms', '#symptoms'), sg);

  const sh = el('div', 'group');
  const a = el('a', 'row row-link'); a.href = '#share';
  const ai = el('span', 'row-ico'); ai.append(icon('share'));
  const am = el('span', 'row-main'); am.append(el('span', 'row-title', 'Export My Record'), el('span', 'row-sub', 'FHIR, International Patient Summary, CSV'));
  a.append(ai, am, icon('chev', 'chev'));
  sh.append(a);
  out.push(el('div', null), sh);
  sh.style.marginTop = '16px';

  out.forEach((n) => { const x = n.querySelector && n.querySelector('a:not([href])'); if (x) x.replaceWith(el('span', 'row-meta', x.textContent)); });
  $('summary').replaceChildren(...out);
}

function renderThread() {
  const ol = $('thread');
  const msgs = [...state.msgs].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  if (!msgs.length) { ol.replaceChildren(emptyBox('No messages', 'Messages from your care team appear here.')); return; }
  const out = [];
  let last = '';
  msgs.forEach((m) => {
    const p = parseTs(m.ts);
    const d = p ? dayName(p) : '';
    if (d && d !== last) { out.push(el('li', 'day-sep', d)); last = d; }
    const mine = m.from === 'patient';
    const li = el('li', 'bubble ' + (mine ? 'me' : 'them'));
    if (!mine) li.append(el('div', 'who', [m.sender || 'Care team', m.priority && m.priority !== 'routine' ? (m.priority === 'soon' ? 'Please respond this week' : 'Urgent') : null].filter(Boolean).join(' · ')));
    li.append(el('div', null, m.body));
    if (!mine && present(m.action)) li.append(el('div', 'who', m.action));
    li.append(el('div', 'when', clock(p)));
    out.push(li);
  });
  ol.replaceChildren(...out);
}

function renderStatus() {
  const s = $('status');
  s.classList.remove('on', 'off', 'lock');
  let t = 'Connecting';
  if (state.online === false) { s.classList.add('off'); t = 'Offline'; }
  else if (state.locked) { t = 'Connecting'; }
  else if (state.online) { s.classList.add('on'); t = 'Up to date'; }
  s.querySelector('.conn-text').textContent = t;
  ['locked-home', 'locked-sym'].forEach((id) => { $(id).hidden = true; });
  $('import-row').classList.toggle('disabled', !(auth() && auth().isUnlocked()));
}

let lastKey = '';
function renderAll(force) {
  const key = JSON.stringify([state.events, state.visits, state.drafts, state.meds, state.doses, state.msgs, state.locked, state.filter, state.visitsTab, location.hash]);
  if (force || key !== lastKey) {
    lastKey = key;
    const sorted = [...state.events].sort(newestFirst);
    renderHome(sorted);
    renderSymptoms();
    renderVisits();
    const [r, id] = location.hash.slice(1).split('/');
    if (r === 'visit') renderVisit(decodeURIComponent(id || ''));
    if (r === 'review') renderReview(decodeURIComponent(id || ''), force);
    renderMeds();
    renderSummary();
    if (SHOW_MESSAGES) renderThread();
    if (DESKTOP) { renderDash(sorted); renderRail(); }
    state.seen = new Set(sorted.map((e) => e.id));
  }
  renderStatus();
  if (DESKTOP) {
    const mb = $('med-badge'), sb = $('side-med-badge');
    sb.hidden = mb.hidden; sb.textContent = mb.textContent;
  }
}

// =====================================================================
// Desktop: sidebar, dashboard of cards, and a right rail with a calendar
// and the care team (the layout of a patient-portal dashboard).
// =====================================================================
const DESKTOP = params.get('view') === 'desktop' || (params.get('view') !== 'phone' && window.innerWidth >= 1100);

function dcardHead(title, linkText, href) {
  const h = el('header', 'dcard-head');
  h.append(el('h2', null, title));
  if (linkText) { const a = el('a', null, linkText); a.href = href; h.append(a); }
  return h;
}
function dcardFoot(text, href) { const f = el('footer', 'dcard-foot'); const a = el('a', null, text); a.href = href; f.append(a); return f; }
function dEmpty(title, body) { const d = el('div', 'dempty'); d.append(icon('doc'), el('b', null, title), el('span', null, body)); return d; }

function renderDash(sorted) {
  const h = new Date().getHours();
  $('dash-greet').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  // Upcoming Visits: the big card
  const hv = $('dc-upcoming');
  hv.replaceChildren();
  const ups = upcoming();
  const hh = el('div', 'dhero-head'); hh.append(el('span', null, 'Upcoming Visits'));
  const allv = el('a', null, 'All Visits'); allv.href = '#visits'; hh.append(allv);
  hv.append(hh);
  if (ups.length) {
    const u = ups[0];
    const main = el('div', 'dhero-main');
    main.append(dateTile(u.p));
    const m = el('div', 'dhero-text');
    m.append(el('h3', null, u.scheduled ? u.title : 'Follow-up Visit'));
    const meta = el('div', 'dhero-meta');
    const ln = (ic, t) => { if (!present(t)) return; const d = el('span'); d.append(icon(ic), document.createTextNode(t)); meta.append(d); };
    ln('clock', [`${weekday(u.p)}, ${MON[u.p.mo - 1]} ${u.p.d}`, u.p.h !== null ? clock(u.p) : null].filter(Boolean).join(' · '));
    ln('person', [u.v.clinician, u.v.specialty].filter(present).join(' · '));
    m.append(meta);
    main.append(m);
    hv.append(main);
    const acts = el('div', 'dhero-actions');
    acts.append(link('Details', u.scheduled ? '#visits' : '#visit/' + encodeURIComponent(u.v.id), 'btn btn-light'),
      link('Health Summary', '#summary', 'btn btn-ghost-light'));
    hv.append(acts);
    if (ups.length > 1) {
      const more = el('div', 'dhero-more');
      ups.slice(1, 3).forEach((x) => { const r = el('span'); r.append(el('b', null, `${MON[x.p.mo - 1]} ${x.p.d}`), document.createTextNode(` ${x.scheduled ? x.title : 'Follow-up Visit'} · ${x.v.clinician || ''}`)); more.append(r); });
      hv.append(more);
    }
  } else {
    hv.append(el('p', 'dhero-empty', 'No upcoming visits'));
  }

  // at a glance: one row of numbers on the background, spread across the width
  const gl = $('dc-glance');
  gl.replaceChildren();
  const nd = nextDose(state.meds);
  const lat = sorted[0];
  const rated = state.events.filter((e) => present(e.severity));
  const last14 = state.events.filter((e) => { const p = parseTs(e.ts); return p && dayDiff(p) < 14; });
  const stripItem = (label, valueEl, subText, href) => {
    const a = el('a', 'strip-item'); a.href = href;
    a.append(el('span', 'strip-l', label), valueEl, el('span', 'strip-s', subText || ''));
    gl.append(a);
  };
  const val = (t) => el('span', 'strip-v', t);
  stripItem('Next dose', val(nd ? hhmm(nd.t) : '—'), nd ? nd.med.name || '' : 'None due today', '#medications');
  if (lat) { const v = sevEl(lat.severity); v.className += ' strip-v'; stripItem('Latest symptom', v, symptomTitle(lat), '#symptoms'); }
  else stripItem('Latest symptom', val('—'), 'None logged', '#log');
  stripItem('Symptoms', val(`${last14.length}`), 'Last 14 days', '#symptoms');
  stripItem('Average', val(rated.length ? `${(rated.reduce((n, e) => n + Number(e.severity), 0) / rated.length).toFixed(1)}/10` : '—'), 'Severity', '#symptoms');
  stripItem('Highest', val(rated.length ? `${Math.max(...rated.map((e) => Number(e.severity)))}/10` : '—'), 'Severity', '#symptoms');

  // To Do's
  const todo = $('dc-todo');
  todo.replaceChildren(dcardHead('To Do'));
  const items = [];
  state.drafts.filter((v) => v.status === 'draft').forEach((v) => items.push(['doc', 'Approve visit note', '', '#review/' + encodeURIComponent(v.id)]));
  state.meds.filter((m) => !m.confirmed_at).forEach((m) => items.push(['med', `Review ${m.name || 'medication'}`, '', '#medications']));
  const lv = pastVisits()[0];
  if (lv && dayDiff(parseTs(lv.ts) || { y: 1970, mo: 1, d: 1 }) <= 7) items.push(['doc', 'After Visit Summary', '', '#visit/' + encodeURIComponent(lv.id)]);
  if (items.length) {
    const list = el('div', 'dlist');
    items.forEach(([ic, t, s, href]) => {
      const a = el('a', 'drow'); a.href = href;
      const i = el('span', 'drow-ico'); i.append(icon(ic));
      const m = el('span', 'row-main'); m.append(el('span', 'row-title', t));
      a.append(i, m, icon('chev', 'chev'));
      list.append(a);
    });
    todo.append(list);
  } else todo.append(dEmpty('Nothing to do', ''));

  // Recent Symptoms: where, what, when, how bad
  const sy = $('dc-symptoms');
  sy.replaceChildren(dcardHead('Recent Symptoms', 'View all', '#symptoms'));
  if (sorted.length) {
    const list = el('div', 'dlist');
    sorted.slice(0, 4).forEach((e) => {
      const r = el('button', 'drow'); r.type = 'button';
      const m = el('span', 'row-main');
      m.append(el('span', 'row-title', symptomTitle(e)), el('span', 'row-sub', whenText(parseTs(e.ts))));
      r.append(symptomFig(e, 'fig-row'), m, sevEl(e.severity));
      r.addEventListener('click', () => symptomSheet(e));
      list.append(r);
    });
    sy.append(list);
  } else sy.append(dEmpty('No symptoms logged', ''));

  // By Body Location: one figure, a marker per reported area
  const bc = $('dc-body');
  bc.replaceChildren(dcardHead('Body Location'));
  const byRegion = {};
  let unplaced = 0;
  state.events.forEach((e) => { const r = regionOf(e.body_location); if (r) byRegion[r.key] = (byRegion[r.key] || 0) + 1; else unplaced++; });
  const regions = Object.entries(byRegion).sort((a, b) => b[1] - a[1]);
  if (state.events.length) {
    const wrap = el('div', 'bodycard');
    wrap.append(bodyFig(regions.map(([key, n]) => ({ key, n })), 'fig-card'));
    const ul = el('ul', 'bodylist');
    const max = Math.max(...regions.map(([, n]) => n), 1);
    regions.forEach(([key, n]) => {
      const li = el('li');
      const bar = el('span', 'bodybar'); const fill = el('i'); fill.style.width = `${(n / max) * 100}%`; bar.append(fill);
      li.append(el('span', 'bodyname', BODY[key].label), bar, el('b', null, n));
      ul.append(li);
    });
    if (unplaced) { const li = el('li', 'muted'); li.append(el('span', 'bodyname', 'Not stated'), el('span', 'bodybar'), el('b', null, unplaced)); ul.append(li); }
    wrap.append(ul);
    bc.append(wrap);
  } else bc.append(dEmpty('No symptoms logged', ''));

  // Track My Health: severity over 14 days, bars or line
  renderTrend();

  // Medications
  const md = $('dc-meds');
  md.replaceChildren(dcardHead('Medications', 'Details', '#medications'));
  if (state.meds.length) {
    const list = el('div', 'dlist');
    const nd = nextDose(state.meds);
    state.meds.forEach((m) => {
      const a = el('a', 'drow'); a.href = '#medications';
      const i = el('span', 'drow-ico'); i.append(icon('med'));
      const mm = el('span', 'row-main');
      mm.append(el('span', 'row-title', m.name || 'Medication'), el('span', 'row-sub', m.dose || ''));
      const end = el('span', 'drow-end');
      end.append(el('span', 'row-meta strong' + (m.confirmed_at ? '' : ' warn'), !m.confirmed_at ? 'Review' : nd && nd.med.id === m.id ? hhmm(nd.t) : (m.times || []).length ? (m.times || []).map(hhmm).join(', ') : 'As needed'));
      a.append(i, mm, end);
      list.append(a);
    });
    md.append(list);
  } else md.append(dEmpty('No medications on file', ''));
}

let chartKind = 'bar';
try { if (localStorage.getItem('vexo-chart') === 'line') chartKind = 'line'; } catch (e) { /* storage off */ }
function renderTrend() {
  const tr = $('dc-trend');
  const head = el('header', 'dcard-head');
  const ht = el('div', 'dcard-title');
  ht.append(el('h2', null, 'Track My Health'), el('span', 'dcard-sub', 'Highest severity each day · last 14 days'));
  const seg = el('div', 'segmented seg-sm'); seg.setAttribute('role', 'tablist'); seg.setAttribute('aria-label', 'Chart type');
  [['bar', 'Bars'], ['line', 'Line']].forEach(([k, t]) => {
    const b = el('button', null, t); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(chartKind === k));
    b.onclick = () => { chartKind = k; try { localStorage.setItem('vexo-chart', k); } catch (e) { /* storage off */ } renderTrend(); };
    seg.append(b);
  });
  head.append(ht, seg);
  tr.replaceChildren(head, severityChart(chartKind));
}

// highest severity each day for 14 days, as bars or as a line with a trend
function severityChart(kind) {
  const wrap = el('div', 'chart');
  const now = new Date();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const evs = state.events.filter((e) => { const p = parseTs(e.ts); return p && p.y === d.getFullYear() && p.mo === d.getMonth() + 1 && p.d === d.getDate(); });
    const sev = evs.map((e) => Number(e.severity)).filter((n) => present(n) && !Number.isNaN(n));
    days.push({ d, n: evs.length, v: sev.length ? Math.max(...sev) : null });
  }
  const W = 640, H = 170, top = 12, pad = 24, bw = (W - pad) / 14;
  const y = (v) => H - (v / 10) * (H - top);
  const cx = (i) => pad + i * bw + bw / 2;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
  const tip = (node, x) => { const t = mk('title', {}); t.textContent = `${MON[x.d.getMonth()]} ${x.d.getDate()}: ${x.v}/10 (${x.n} report${x.n > 1 ? 's' : ''})`; node.append(t); return node; };
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H + 22}`, class: 'chart-svg', role: 'img' });
  [0, 5, 10].forEach((v) => {
    svg.append(mk('line', { x1: pad, x2: W, y1: y(v), y2: y(v), class: 'grid' }));
    const t = mk('text', { x: 0, y: y(v) + 4, class: 'axis' }); t.textContent = v; svg.append(t);
  });
  days.forEach((x, i) => {
    if (i % 2 === 1 || i === 13) { const t = mk('text', { x: cx(i), y: H + 16, class: 'axis mid-anchor' }); t.textContent = i === 13 ? 'Today' : `${x.d.getDate()}`; svg.append(t); }
  });
  const pts = days.map((x, i) => ({ ...x, i })).filter((x) => x.v !== null);
  const legend = el('div', 'legend');
  if (kind === 'line') {
    if (pts.length) {
      const grad = mk('linearGradient', { id: 'trend-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(mk('stop', { offset: '0%', class: 'area-top' }), mk('stop', { offset: '100%', class: 'area-bot' }));
      const defs = mk('defs', {}); defs.append(grad); svg.append(defs);
      const line = pts.map((p, k) => `${k ? 'L' : 'M'}${cx(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
      if (pts.length > 1) svg.append(mk('path', { d: `${line} L${cx(pts[pts.length - 1].i).toFixed(1)},${H} L${cx(pts[0].i).toFixed(1)},${H} Z`, class: 'area', fill: 'url(#trend-fill)' }));
      // straight-line trend through the rated days (least squares), drawn dashed
      if (pts.length > 2) {
        const n = pts.length, sx = pts.reduce((a, p) => a + p.i, 0), sy = pts.reduce((a, p) => a + p.v, 0);
        const sxx = pts.reduce((a, p) => a + p.i * p.i, 0), sxy = pts.reduce((a, p) => a + p.i * p.v, 0);
        const m = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), c = (sy - m * sx) / n;
        const clamp = (v) => Math.min(10, Math.max(0, v));
        const i0 = pts[0].i, i1 = pts[n - 1].i;
        svg.append(mk('line', { x1: cx(i0), y1: y(clamp(m * i0 + c)), x2: cx(i1), y2: y(clamp(m * i1 + c)), class: 'trendline' }));
      }
      svg.append(mk('path', { d: line, class: 'line' }));
      pts.forEach((p, k) => svg.append(tip(mk('circle', { cx: cx(p.i), cy: y(p.v), r: k === pts.length - 1 ? 5 : 3.5, class: 'pt' + (k === pts.length - 1 ? ' last' : '') }), p)));
      const lastP = pts[pts.length - 1];
      const lab = mk('text', { x: cx(lastP.i), y: y(lastP.v) - 10, class: 'pt-label mid-anchor' }); lab.textContent = `${lastP.v}/10`; svg.append(lab);
    }
    [['ln', 'Highest each day'], ['tl', 'Trend']].forEach(([c, t]) => { const s = el('span', 'lg'); s.append(el('i', 'sw-line ' + c), document.createTextNode(t)); legend.append(s); });
  } else {
    days.forEach((x, i) => {
      const w = bw * 0.56, bx = cx(i) - w / 2;
      if (x.v !== null) {
        const hgt = Math.max(4, (x.v / 10) * (H - top));
        svg.append(tip(mk('rect', { x: bx, y: H - hgt, width: w, height: hgt, rx: 4, class: 'bar ' + (x.v >= 7 ? 'high' : x.v >= 4 ? 'mid' : 'low') }), x));
      } else if (x.n) svg.append(mk('rect', { x: bx, y: H - 4, width: w, height: 4, rx: 2, class: 'bar none' }));
    });
    [['low', '0–3'], ['mid', '4–6'], ['high', '7–10'], ['none', 'Not rated']].forEach(([c, t]) => { const s = el('span', 'lg'); s.append(el('i', 'sw ' + c), document.createTextNode(t)); legend.append(s); });
  }
  svg.setAttribute('aria-label', `${kind === 'line' ? 'Line' : 'Bar'} chart of highest severity per day over 14 days; ${pts.length} days with a rating`);
  wrap.append(svg, legend);
  return wrap;
}

// ---------- right rail: month calendar, selected day, care team ----------
const cal = { y: new Date().getFullYear(), m: new Date().getMonth(), sel: null };
function dayKey(p) { return `${p.y}-${p.mo}-${p.d}`; }
function itemsByDay() {
  const map = {};
  const add = (p, item) => { if (!p) return; (map[dayKey(p)] = map[dayKey(p)] || []).push(item); };
  state.events.forEach((e) => add(parseTs(e.ts), { kind: 'symptom', t: e.ts, e }));
  state.visits.forEach((v) => { add(parseTs(v.ts), { kind: 'visit', t: v.ts, v }); if (present(v.follow_up)) add(parseTs(v.follow_up), { kind: 'followup', t: v.follow_up, v }); });
  state.doses.forEach((d) => add(parseTs(doseTime(d)), { kind: 'dose', t: doseTime(d), d }));
  return map;
}
function renderRail() {
  const map = itemsByDay();
  const now = new Date();
  if (!cal.sel) cal.sel = { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
  const box = $('cal');
  box.replaceChildren();
  const head = el('div', 'cal-head');
  head.append(el('h2', null, `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][cal.m]} ${cal.y}`));
  const nav = el('div', 'cal-nav');
  const prev = el('button', 'cal-btn'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous month'); prev.append(icon('back'));
  const next = el('button', 'cal-btn'); next.type = 'button'; next.setAttribute('aria-label', 'Next month'); next.append(icon('chev'));
  prev.onclick = () => { cal.m--; if (cal.m < 0) { cal.m = 11; cal.y--; } renderRail(); };
  next.onclick = () => { cal.m++; if (cal.m > 11) { cal.m = 0; cal.y++; } renderRail(); };
  nav.append(prev, next); head.append(nav);
  box.append(head);
  const grid = el('div', 'cal-grid');
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => grid.append(el('span', 'cal-dow', d)));
  const first = new Date(cal.y, cal.m, 1).getDay();
  const days = new Date(cal.y, cal.m + 1, 0).getDate();
  for (let i = 0; i < first; i++) grid.append(el('span'));
  for (let d = 1; d <= days; d++) {
    const p = { y: cal.y, mo: cal.m + 1, d };
    const items = map[dayKey(p)] || [];
    const b = el('button', 'cal-day'); b.type = 'button';
    if (p.y === now.getFullYear() && p.mo === now.getMonth() + 1 && d === now.getDate()) b.classList.add('today');
    if (cal.sel && dayKey(cal.sel) === dayKey(p)) b.classList.add('sel');
    b.append(el('span', null, d));
    const dots = el('span', 'cal-dots');
    ['symptom', 'visit', 'followup', 'dose'].forEach((k) => { if (items.some((x) => x.kind === k)) dots.append(el('i', 'dot ' + k)); });
    b.append(dots);
    b.setAttribute('aria-label', `${MON[cal.m]} ${d}${items.length ? `, ${items.length} item${items.length > 1 ? 's' : ''}` : ''}`);
    b.onclick = () => { cal.sel = p; renderRail(); };
    grid.append(b);
  }
  box.append(grid);
  const sel = el('div', 'cal-sel'); sel.append(el('span', null, 'Selected day:'), el('b', null, `${weekday(cal.sel)}, ${MON[cal.sel.mo - 1]} ${cal.sel.d}`));
  box.append(sel);

  // selected day's items as tinted cards
  const dayBox = $('cal-day');
  dayBox.replaceChildren();
  const its = (map[dayKey(cal.sel)] || []).sort((a, b) => String(a.t).localeCompare(String(b.t)));
  if (!its.length) dayBox.append(el('p', 'cal-none', 'Nothing logged on this day.'));
  its.forEach((it) => {
    const p = parseTs(it.t);
    const a = el('a', 'ev ' + it.kind);
    const top = el('span', 'ev-top'); top.append(icon(it.kind === 'symptom' ? 'symptom' : it.kind === 'dose' ? 'med' : 'visit'));
    if (it.kind === 'symptom') {
      a.href = '#symptoms';
      top.append(el('span', null, symptomTitle(it.e)));
      a.append(top, el('span', 'ev-time', [clock(p), sevText(it.e.severity)].filter(Boolean).join(' · ')));
      a.addEventListener('click', (ev) => { ev.preventDefault(); symptomSheet(it.e); });
    } else if (it.kind === 'dose') {
      a.href = '#medications';
      top.append(el('span', null, cap(it.d.medication_name) || 'Medication'));
      a.append(top, el('span', 'ev-time', `Taken ${clock(p)}`));
    } else {
      a.href = '#visit/' + encodeURIComponent(it.v.id);
      top.append(el('span', null, it.kind === 'followup' ? 'Follow-up Visit' : (it.v.specialty || 'Office Visit')));
      a.append(top, el('span', 'ev-time', it.kind === 'followup' ? 'Time to be scheduled' : clock(p)), el('span', 'ev-sub', it.v.clinician || ''));
    }
    dayBox.append(a);
  });

  // Care Team, from the clinicians on your visits
  const ct = $('care-team');
  ct.replaceChildren(el('h2', null, 'Care Team'));
  const team = {};
  state.visits.forEach((v) => { if (present(v.clinician)) team[v.clinician] = team[v.clinician] || v; });
  const people = Object.values(team);
  if (!people.length) { ct.append(el('p', 'cal-none', 'Clinicians from your visits appear here.')); return; }
  const list = el('div', 'team');
  people.forEach((v) => {
    const row = el('div', 'team-row');
    const ini = String(v.clinician).replace(/^Dr\.?\s*/i, '').split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();
    row.append(el('span', 'avatar-ini', ini));
    const m = el('div', 'row-main');
    m.append(el('span', 'row-title', v.clinician), el('span', 'row-sub', v.specialty || 'Clinician'));
    const acts = el('div', 'team-acts');
    const a = el('a', null); a.href = '#visit/' + encodeURIComponent(v.id); a.setAttribute('aria-label', `Last visit with ${v.clinician}`); a.append(icon('visit'));
    acts.append(a);
    m.append(acts);
    row.append(m);
    list.append(row);
  });
  ct.append(list);
}

// switch layout: move the shared screens into the desktop frame
if (DESKTOP) {
  document.body.classList.add('desktop');
  $('desk').hidden = false;
  $('desk-main').append($('screen'));
  document.body.append($('sheet-backdrop'), $('sheet'));
  document.querySelector('.stage').hidden = true;
  // top bar slides away while scrolling down, comes back on scroll up or near the top
  let lastY = 0;
  const bar = document.querySelector('.desk-top');
  $('desk-main').addEventListener('scroll', (e) => {
    const y = e.target.scrollTop;
    if (y < 40) bar.classList.remove('tucked');
    else if (y > lastY + 4) bar.classList.add('tucked');
    else if (y < lastY - 4) bar.classList.remove('tucked');
    lastY = y;
  }, { passive: true });
  const railBtn = $('rail-toggle');
  const setRail = (open) => {
    $('desk').classList.toggle('rail-off', !open);
    railBtn.setAttribute('aria-expanded', String(open));
    const t = open ? 'Hide calendar' : 'Show calendar';
    railBtn.setAttribute('aria-label', t); railBtn.title = t;
    try { localStorage.setItem('vexo-rail', open ? 'open' : 'closed'); } catch (e) { /* storage off */ }
  };
  let railOpen = true;
  try { railOpen = localStorage.getItem('vexo-rail') !== 'closed'; } catch (e) { /* storage off */ }
  setRail(railOpen);
  railBtn.addEventListener('click', () => setRail($('desk').classList.contains('rail-off')));
  $('desk-search').addEventListener('input', (e) => { $('search').value = e.target.value; state.filter.q = e.target.value; if (!location.hash.startsWith('#symptoms')) location.hash = '#symptoms'; renderAll(); });
}
window.matchMedia('(min-width: 1100px)').addEventListener('change', (e) => { if (!params.get('view') && e.matches !== DESKTOP) location.reload(); });

// ---------- routing ----------
function route() {
  const [r] = location.hash.slice(1).split('/');
  let name = ROUTES[r] ? r : 'home';
  if (name === 'messages' && !SHOW_MESSAGES) name = 'home';
  const cfg = ROUTES[name];
  const viewId = DESKTOP && name === 'home' ? 'view-dash' : 'view-' + name;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== viewId; });
  document.querySelectorAll('[data-tab]').forEach((a) => {
    const on = DESKTOP && a.closest('.side') ? a.dataset.tab === (name === 'share' ? 'share' : cfg.tab) : a.dataset.tab === cfg.tab;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (DESKTOP) { $('desk-main').scrollTop = 0; document.title = (cfg.title || 'Home') + ' · Vexl'; }
  const sub = name !== 'home';
  $('topbar').classList.toggle('sub', sub);
  $('navbar').hidden = !sub;
  $('nav-title').textContent = cfg.title || '';
  // keep the back slot in the grid so the title stays centred
  $('nav-back').style.visibility = cfg.back ? 'visible' : 'hidden';
  if (cfg.back) { $('nav-back').href = cfg.back[0]; $('nav-back-label').textContent = cfg.back[1]; }
  if (!$('sheet').hidden) closeSheet();
  $('screen').scrollTop = 0;
  renderAll(true);
}
window.addEventListener('hashchange', route);

// ---------- greeting ----------
(() => { const h = new Date().getHours(); $('greet').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();

// ---------- messages on/off ----------
document.querySelectorAll('[data-msg]').forEach((n) => { n.hidden = !SHOW_MESSAGES; });
document.querySelectorAll('[data-nomsg]').forEach((n) => { n.hidden = SHOW_MESSAGES; });

// ---------- symptoms controls ----------
$('search').addEventListener('input', (e) => { state.filter.q = e.target.value; renderAll(); });
$('seg-source').addEventListener('click', (e) => {
  const b = e.target.closest('[data-src]'); if (!b) return;
  state.filter.src = b.dataset.src;
  document.querySelectorAll('#seg-source [data-src]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  renderAll();
});
$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-loc]'); if (!b) return;
  state.filter.loc = state.filter.loc === b.dataset.loc ? '' : b.dataset.loc;
  renderAll();
});
$('seg-visits').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  state.visitsTab = b.dataset.v; renderAll();
});

// ---------- log a symptom ----------
const sev = $('sev'), sevOn = $('sev-on');
function updateSev() {
  $('sev-row').hidden = !sevOn.checked;
  const out = $('sev-out');
  out.textContent = sevOn.checked ? `${sev.value}/10` : 'Not rated';
  out.className = 'sev-val' + (sevOn.checked ? '' : ' muted');
}
sev.addEventListener('input', updateSev);
sevOn.addEventListener('change', updateSev);

$('logger-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('form-msg');
  const quote = $('q').value.trim();
  if (!quote) { msg.className = 'form-msg err'; msg.textContent = 'Describe what you are feeling first.'; $('q').focus(); return; }
  const clean = (v) => (v.trim() ? v.trim() : null);
  const b = $('submit');
  b.disabled = true; msg.className = 'form-msg'; msg.textContent = 'Saving…';
  try {
    await post('/Observation', {
      id: 'evt-' + Date.now(), ts: localIso(), schema_version: '0.1', source: 'manual', audio_seconds: 0,
      verbatim_quote: quote, body_location: clean($('loc').value), quality: clean($('qual').value), activity: clean($('act').value),
      severity: sevOn.checked ? Number(sev.value) : null,   // never a guessed number
      transcript_model: null, extract_model: null,
    });
    ev.target.reset(); updateSev();
    msg.className = 'form-msg ok'; msg.textContent = 'Saved.';
    await refresh();
    setTimeout(() => { msg.textContent = ''; location.hash = '#symptoms'; }, 700);
  } catch (err) {
    msg.className = 'form-msg err';
    msg.textContent = 'Not saved. The records server did not respond.';
  } finally { b.disabled = false; }
});

// ---------- messages composer ----------
$('composer').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = $('reply').value.trim();
  if (!text) return;
  try {
    await post('/Communication', { id: 'msg-' + Date.now(), ts: localIso(), schema_version: '0.1', thread: 'general', from: 'patient', to: 'clinician', sender: 'You', body: text, priority: null, action: null, related_event_ids: [] });
    $('reply').value = ''; $('reply-msg').textContent = ''; refresh();
  } catch (_) { $('reply-msg').className = 'form-msg err'; $('reply-msg').textContent = 'Not sent. Try again.'; }
});

// ---------- share: export + import ----------
const FORMATS = {
  fhir: { tag: 'FHIR', name: 'Clinical record', why: 'Imports into a clinic\'s electronic health record.', url: '/export/fhir' },
  ips:  { tag: 'IPS',  name: 'International Patient Summary', why: 'A summary any doctor can open, in any country.', url: '/export/ips' },
  csv:  { tag: 'CSV',  name: 'Spreadsheet', why: 'One row per symptom, for Excel or Numbers.', url: '/export/csv' },
  json: { tag: 'JSON', name: 'Full backup', why: 'Everything, exactly as stored.', url: '/export/json' },
};
const WHERE = [['us', 'United States'], ['eu', 'Europe'], ['other', 'Somewhere else'], ['unsure', 'Not sure']];
const ORDER = { us: ['fhir', 'ips', 'csv', 'json'], eu: ['ips', 'fhir', 'csv', 'json'], other: ['ips', 'fhir', 'csv', 'json'], unsure: ['ips', 'fhir', 'csv', 'json'], me: ['csv', 'json', 'ips', 'fhir'] };
const share = { who: 'clinic', where: 'us' };
function renderShare() {
  const box = $('share-flow');
  const out = [];
  const question = (label, options, value, onPick) => {
    const seg = el('div', 'segmented'); seg.setAttribute('role', 'tablist'); seg.setAttribute('aria-label', label);
    options.forEach(([v, text]) => {
      const b = el('button', null, text); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(v === value));
      b.addEventListener('click', () => { onPick(v); renderShare(); });
      seg.append(b);
    });
    out.push(sectionLabel(label), seg);
  };
  question('Who is this for?', [['clinic', 'A doctor or clinic'], ['me', 'Myself']], share.who, (v) => { share.who = v; });
  if (share.who === 'clinic') question('Where is the doctor or clinic?', WHERE, share.where, (v) => { share.where = v; });
  const order = ORDER[share.who === 'me' ? 'me' : share.where];
  const fmtRow = (key, primary) => {
    const f = FORMATS[key];
    const a = el('a', 'row row-link' + (primary ? ' fmt-primary' : '')); a.href = API + f.url; a.target = '_blank'; a.rel = 'noopener';
    const m = el('span', 'row-main'); m.append(el('span', 'row-title', f.name), el('span', 'row-sub wrap', f.why));
    a.append(el('span', 'fmt-tag', f.tag), m, primary ? el('span', 'btn btn-primary btn-sm', 'Download') : icon('chev', 'chev'));
    return a;
  };
  const best = el('div', 'group'); best.append(fmtRow(order[0], true));
  out.push(sectionLabel('Recommended'), best);
  const rest = el('div', 'group'); order.slice(1).forEach((k) => rest.append(fmtRow(k, false)));
  out.push(sectionLabel('Other formats'), rest);
  box.replaceChildren(...out);
}
renderShare();
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  const msg = $('import-msg');
  e.target.value = '';
  if (!file) return;
  if (!window.vexoImport) { msg.className = 'form-msg err'; msg.textContent = 'Import is not available on this server.'; return; }
  if (!(auth() && auth().isUnlocked())) { msg.className = 'form-msg err'; msg.textContent = 'Unlock first. Records are sealed before they are sent.'; return; }
  msg.className = 'form-msg'; msg.textContent = 'Importing…';
  try {
    const r = await window.vexoImport.importFile(file);
    msg.className = 'form-msg ok';
    msg.textContent = `Imported ${r.imported}${r.skipped ? `, skipped ${r.skipped}` : ''}${r.errors && r.errors.length ? `, ${r.errors.length} failed` : ''}.`;
    announce(); refresh();
  } catch (_) { msg.className = 'form-msg err'; msg.textContent = 'That file could not be read as a FHIR Bundle or an app backup.'; }
});

// ---------- start ----------
window.addEventListener('vexo-unlocked', () => refresh());
window.addEventListener('vexo-imported', () => refresh());
updateSev();
route();
(async () => {
  const a = auth();
  // the bridge may have been down at load: retry a few times, then let the person
  // paste the key rather than sit on a silently empty dashboard
  if (a && !a.isUnlocked() && a.autoUnlock) {
    for (let i = 0; i < 3 && !a.isUnlocked(); i++) {
      try { await a.autoUnlock(); } catch (_) { /* bridge not running */ }
      if (!a.isUnlocked()) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!a.isUnlocked() && a.showUnlock) a.showUnlock();
  }
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
