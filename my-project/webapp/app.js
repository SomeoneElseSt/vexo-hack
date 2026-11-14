// Symptom Log frontend. Plain JS, no build step.
// Everything shown comes from the records server (records_server.py); nothing is invented here.
// Text from the server was spoken by a patient, so it is only ever shown with textContent.
'use strict';

// ---------- config ----------
// Same origin by default. Override with ?api=http://host:8766 to point at another records server.
const API = (() => {
  try {
    const v = new URLSearchParams(location.search).get('api');
    if (v && /^https?:\/\//.test(v)) return v.replace(/\/+$/, '');
  } catch (_) { /* ignore */ }
  return '';
})();
const REFRESH_MS = 5000;
const RECENT_COUNT = 3;
const BRIDGE = 'http://127.0.0.1:8768';   // the local bridge on this device

// ---------- device unlock (WebCrypto) ----------
// The local bridge holds the device key; it hands over an auth token and the
// AES-GCM key, never the raw secret. Records are sealed blobs until then.
const session = { auth: null, aesKey: null, deviceId: null };

async function unlock() {
  try {
    const res = await fetch(BRIDGE + '/session', { cache: 'no-store' });
    if (!res.ok) return false;
    const s = await res.json();
    session.auth = s.auth;
    session.deviceId = s.device_id;
    session.aesKey = await crypto.subtle.importKey(
      'raw', b64ToBytes(s.aes_key), { name: 'AES-GCM' }, false, ['decrypt']);
    setLocked(false);
    return true;
  } catch (_) {
    return false;
  }
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function decryptSealed(rec) {
  if (!session.aesKey) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(rec.nonce), additionalData: new TextEncoder().encode(session.deviceId) },
      session.aesKey, b64ToBytes(rec.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (_) {
    return null;   // not this device's record, or tampered
  }
}

function setLocked(locked) {
  const banner = $('lock-banner');
  if (banner) banner.hidden = !locked;
}

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

const present = (v) => v !== null && v !== undefined && String(v).trim() !== '';

async function api(path, options) {
  const headers = { ...((options && options.headers) || {}) };
  if (session.auth) headers['X-Device-Auth'] = session.auth;
  const res = await fetch(API + path, { cache: 'no-store', ...options, headers });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

// The patient's local clock matters ("6:22pm, on the stairs"), so read the time as written
// in the timestamp, with its own offset, instead of converting it to this browser's zone.
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseTs(ts) {
  const m = TS_RE.exec(ts || '');
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return { y, mo, d, h, mi };
}

function clock(p) {
  const h12 = p.h % 12 || 12;
  return `${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'am' : 'pm'}`;
}

function dayLabel(p) {
  const now = new Date();
  const that = new Date(p.y, p.mo - 1, p.d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${MONTHS[p.mo - 1]} ${p.d}${p.y !== now.getFullYear() ? ', ' + p.y : ''}`;
}

function severityPill(sev) {
  const n = Number(sev);
  if (!present(sev) || Number.isNaN(n)) return el('span', 'pill pill-none', 'Not stated');
  const cls = n >= 7 ? 'pill-high' : n >= 4 ? 'pill-mid' : 'pill-low';
  const pill = el('span', `pill ${cls}`, `${n} / 10`);
  pill.setAttribute('aria-label', `Severity ${n} out of 10`);
  return pill;
}

function sortNewestFirst(events) {
  return [...events].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
}

// ---------- event card ----------
function eventCard(e, isNew) {
  const li = el('li', 'event' + (isNew ? ' new' : ''));

  const when = el('div', 'when');
  const p = parseTs(e.ts);
  when.append(el('span', 'when-time', p ? clock(p) : '–'), el('span', 'when-day', p ? dayLabel(p) : ''));

  const what = el('div', 'what');
  const titleParts = [e.quality, e.body_location].filter(present);
  const title = el('div', 'what-title' + (titleParts.length ? '' : ' untitled'),
    titleParts.length ? titleParts.join(' · ') : 'Symptom noted');
  what.append(title);

  if (present(e.verbatim_quote)) {
    const q = el('p', 'quote');
    q.append(el('span', 'quote-text', e.verbatim_quote));
    what.append(q);
  }

  const meta = el('div', 'meta');
  if (present(e.activity)) meta.append(el('span', 'chip', e.activity));
  meta.append(el('span', null, e.source === 'band' ? 'Logged on the band' : e.source === 'manual' ? 'Typed in' : (e.source || 'Unknown source')));
  if (Number(e.audio_seconds) > 0) meta.append(el('span', null, `${Number(e.audio_seconds).toFixed(1)} s of audio`));
  const models = [e.transcript_model, e.extract_model].filter(present);
  if (models.length) meta.append(el('span', null, 'Local models: ' + models.join(', ')));
  what.append(meta);

  li.append(when, what, severityPill(e.severity));
  return li;
}

function emptyState(title, body) {
  const box = el('li', 'empty-state');
  box.append(el('strong', null, title), el('span', null, body));
  return box;
}

// ---------- renderers ----------
let knownIds = null;   // ids seen on the previous refresh, to highlight new arrivals

function renderEvents(events) {
  const sorted = sortNewestFirst(events);
  const firstLoad = knownIds === null;
  const isNew = (e) => !firstLoad && !knownIds.has(e.id);

  const full = $('timeline-list');
  full.replaceChildren(...(sorted.length
    ? sorted.map((e) => eventCard(e, isNew(e)))
    : [emptyState('No symptoms logged yet', 'Tap your band and say what you feel, or use “Log a symptom”.')]));

  const recent = $('recent-list');
  recent.replaceChildren(...(sorted.length
    ? sorted.slice(0, RECENT_COUNT).map((e) => eventCard(e, isNew(e)))
    : [emptyState('Nothing here yet', 'Your latest symptoms will show up here as you log them.')]));

  knownIds = new Set(sorted.map((e) => e.id));

  // tiles
  $('t-count').textContent = sorted.length;
  const withSev = sorted.filter((e) => present(e.severity));
  $('t-max').textContent = withSev.length ? `${Math.max(...withSev.map((e) => Number(e.severity)))}/10` : '–';
  $('t-band').textContent = sorted.filter((e) => e.source === 'band').length;
  const last = sorted[0] && parseTs(sorted[0].ts);
  $('t-last').textContent = last ? `${dayLabel(last)}, ${clock(last)}` : '–';
}

function setField(id, value, opts = {}) {
  const dd = $(id);
  const has = present(value);
  dd.textContent = has ? (opts.format ? opts.format(value) : value) : (opts.empty || 'Not stated');
  dd.className = has ? (opts.quote ? 'quote' : '') : 'empty';
}

let lastFormKey = '';

function renderForm(form) {
  setField('f-cc', form.chief_complaint, { empty: 'Not enough information yet' });
  setField('f-hpi', form.hpi, { empty: 'Not enough information yet', quote: true });
  setField('f-sev', form.severity, { format: (v) => `${v} / 10` });
  setField('f-act', form.activity);
  setField('f-count', form.event_count ?? 0);
  setField('f-src', form.source, { empty: '–' });

  // A new draft needs a fresh review.
  const key = JSON.stringify([form.chief_complaint, form.hpi, form.severity, form.activity, form.event_count]);
  if (lastFormKey && key !== lastFormKey) setReviewed(false);
  lastFormKey = key;
}

// ---------- doctor review gate (this browser only) ----------
function setReviewed(on) {
  $('gate').classList.toggle('reviewed', on);
  $('gate-badge').textContent = on ? 'Reviewed by doctor' : 'Draft · awaiting doctor review';
  $('gate-btn').textContent = on ? 'Undo review' : 'Mark as reviewed';
}
$('gate-btn').addEventListener('click', () => setReviewed(!$('gate').classList.contains('reviewed')));

// ---------- connection status ----------
function setStatus(ok, text) {
  const s = $('status');
  s.classList.toggle('live', ok);
  s.classList.toggle('down', !ok);
  s.querySelector('.status-text').textContent = text;
}

// ---------- refresh loop ----------
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (!session.auth && !(await unlock())) {
      setStatus(false, 'Locked');
      setLocked(true);
      return;
    }
    // The VM only holds sealed blobs; decrypts happen here, with this device's key.
    const raw = await api('/Observation');
    const events = (await Promise.all(raw.map(decryptSealed))).filter(Boolean);
    renderEvents(events);
    const form = events.length ? null : await api('/api/form').catch(() => null);
    renderForm(form || {});
    setStatus(true, 'Live');
  } catch (err) {
    setStatus(false, 'Records server offline');
    if (knownIds === null) {
      const msg = 'Could not reach the records server. It may be starting up; this page retries every few seconds.';
      $('timeline-list').replaceChildren(emptyState('Waiting for the records server', msg));
      $('recent-list').replaceChildren(emptyState('Waiting for the records server', msg));
    }
  } finally {
    refreshing = false;
  }
}

// ---------- logger ----------
const sev = $('sev'), sevOn = $('sev-on');
function updateSev() {
  sev.disabled = !sevOn.checked;
  const pill = severityPill(sevOn.checked ? sev.value : null);
  const out = $('sev-out');                 // update in place: the element stays the same
  out.className = pill.className;
  out.textContent = pill.textContent;
}
sev.addEventListener('input', updateSev);
sevOn.addEventListener('change', updateSev);

$('logger-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('form-msg');
  const quote = $('q').value.trim();
  if (!quote) {
    msg.className = 'form-msg err';
    msg.textContent = 'Write a few words about what you feel first.';
    $('q').focus();
    return;
  }
  const clean = (v) => (v.trim() ? v.trim() : null);
  const body = {
    schema_version: '0.1',
    source: 'manual',
    audio_seconds: 0,
    verbatim_quote: quote,
    body_location: clean($('loc').value),
    quality: clean($('qual').value),
    activity: clean($('act').value),
    severity: sevOn.checked ? Number(sev.value) : null,   // never a guessed number
    transcript_model: null,
    extract_model: null,
  };
  const btn = $('submit');
  btn.disabled = true;
  msg.className = 'form-msg';
  msg.textContent = 'Saving…';
  try {
    // Sealed with this device's key, so the VM stores it without ever reading it.
    const sealed = await sealEvent(body);
    await api('/Observation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { id: sealed.id, device: session.deviceId }, sealed: sealed.blob }),
    });
    ev.target.reset();
    updateSev();
    msg.className = 'form-msg ok';
    msg.textContent = 'Saved to your log.';
    refresh();
  } catch (err) {
    msg.className = 'form-msg err';
    msg.textContent = 'Could not save: the records server did not answer. Try again in a moment.';
  } finally {
    btn.disabled = false;
  }
});

// ---------- export ----------
document.querySelectorAll('[data-export]').forEach((a) => {
  const path = a.dataset.export;
  a.href = API + path;
  a.target = '_blank';
  a.rel = 'noopener';
});

// ---------- sealing in the browser (AES-GCM with the agent's key) ----------
async function sealEvent(event) {
  const id = 'evt-' + Date.now();
  const full = { id, ts: new Date().toISOString(), ...event };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(session.deviceId) },
    session.aesKey, new TextEncoder().encode(JSON.stringify(full)));
  return {
    id,
    blob: {
      nonce: btoa(String.fromCharCode(...iv)),
      ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
    },
  };
}

// ---------- tabs ----------
const VIEWS = ['overview', 'timeline', 'logger', 'export'];
function route() {
  const id = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  VIEWS.forEach((v) => { $(v).hidden = v !== id; });
  document.querySelectorAll('[data-tab]').forEach((a) => {
    if (a.dataset.tab === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- start ----------
route();
updateSev();
refresh();
setInterval(refresh, REFRESH_MS);
