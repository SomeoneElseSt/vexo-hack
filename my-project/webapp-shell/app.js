// Vexo records shell: views (overview, records, export, settings) over the
// sealed-record API. Key handling lives entirely in unlock.js (window.vexoAuth);
// this file only consumes it and never touches key material.
'use strict';

(function () {
  // Same-origin by default (serve this folder from records_server.py or the
  // static server); RECORDS_ORIGIN only matters when the API lives elsewhere.
  const ORIGIN = window.RECORDS_ORIGIN || '';
  const BRIDGE_HINT = 'python my-project/local_bridge.py --allow ' + location.origin;

  const els = {
    nav: document.getElementById('nav'),
    content: document.getElementById('content'),
    title: document.getElementById('page-title'),
    status: document.getElementById('status'),
    hint: document.getElementById('status-hint'),
    sidebar: document.getElementById('sidebar'),
    toggle: document.getElementById('toggle'),
  };

  // plain words for the record kinds the API can return - no FHIR names in the UI
  const KIND_LABELS = {
    Observation: 'symptom',
    Encounter: 'visit',
    Communication: 'message',
    MedicationRequest: 'medication prescribed',
    MedicationAdministration: 'medication taken',
  };

  // the last tab you were on survives a reload
  function savedView() {
    try { return localStorage.getItem('vexo.view') || 'overview'; } catch (_) { return 'overview'; }
  }
  function saveView(view) {
    try { localStorage.setItem('vexo.view', view); } catch (_) { /* private mode: no cache */ }
  }

  const state = {
    view: savedView(),
    raw: [],          // sealed rows of every kind, kept so polling can diff them
    visits: [],
    meds: [],
    calMonth: null,   // {y, m} for the overview calendar
    calSel: null,     // selected day {y, mo, d}
    openId: null,     // the record whose full metadata is shown

    latestTs: '',
    freshIds: new Set(),
    pollTimer: null,
    events: [],
    offline: false,
    loaded: false,
    filter: '',
    page: 1,
    pageSize: 10,
    rowsOpen: false,
  };

  // ---------- data ----------

  async function api(path) {
    const res = await fetch(ORIGIN + path, {
      cache: 'no-store',
      headers: window.vexoAuth.headers(),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function loadKind(path) {
    try { return await api(path); } catch (_) { return []; }
  }

  async function loadRecords() {
    const [obs, enc, med] = await Promise.all([
      loadKind('/Observation'), loadKind('/Encounter'), loadKind('/MedicationRequest'),
    ]);
    const events = await window.vexoAuth.decryptRows(obs);
    state.visits = (await window.vexoAuth.decryptRows(enc))
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    state.meds = (await window.vexoAuth.decryptRows(med))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const newest = events.reduce((best, e) => ((e.ts || '') > (best.ts || '') ? e : best), {});
    const changed = !state.loaded || events.length !== state.events.length
      || (newest.ts || '') !== (state.latestTs || '');
    state.events = events;
    state.latestTs = newest.ts || '';
    state.loaded = true;
    if (!changed) return;
    state.freshIds = new Set(changed && newest.id ? [newest.id] : []);
    render();
    state.freshIds = new Set();   // shown once, then gone
  }

  const POLL_MS = 3000;
  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (!window.vexoAuth.isUnlocked()) return;
      loadRecords().catch(() => {});
    }, POLL_MS);
  }

  function safeLoadRecords() {
    loadRecords().catch(() => {
      state.offline = true;
      state.loaded = false;
      render();
    });
  }

  // ---------- status ----------

  function statusOf() {
    if (!window.vexoAuth.isUnlocked()) return 'nokey';
    if (state.offline) return 'offline';
    return state.loaded ? 'online' : 'decrypting';
  }

  function renderStatus() {
    const s = statusOf();
    const labels = {
      online: 'Online',
      offline: 'Offline',
      decrypting: 'Decrypting…',
      nokey: 'Offline - no key',
    };
    els.status.dataset.state = s;
    els.status.hidden = s === 'online';
    els.status.querySelector('.status-label').textContent = labels[s];
    els.hint.hidden = s !== 'nokey' && s !== 'offline';
    if (s === 'nokey') {
      els.hint.innerHTML = 'No device key found on this machine. Records stay sealed without it. '
        + 'Start the local bridge with <code>' + BRIDGE_HINT + '</code>, or paste your key - '
        + 'from another device, open Settings → Pair a device.';
    } else if (s === 'offline') {
      els.hint.textContent = 'The records server did not answer. Check that it is running, then retry.';
    }
  }

  // ---------- views ----------

  function fmtTs(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function sevClass(sev) {
    if (sev === null || sev === undefined) return 'none';
    if (sev >= 7) return 'high';
    if (sev >= 4) return 'mid';
    return 'low';
  }

  function esc(text) {
    return String(text ?? '').replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const dayKeyOf = (ts) => {
    const d = ts ? new Date(ts) : null;
    return d && !Number.isNaN(d.getTime()) ? dayKey(d) : null;
  };

  const KINDS = ['visit', 'followup', 'symptom', 'med'];
  // the three boxes under the calendar, always in this order
  const SEL_KINDS = ['symptom', 'visit', 'med'];
  const GROUP_TITLES = { symptom: 'Symptoms', visit: 'Visits', med: 'Medications' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const MON = MONTHS.map((x) => x.slice(0, 3));
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // everything that has a date: symptoms, visits, follow-ups, medications
  function itemsByDay() {
    const map = {};
    const add = (ts, item) => {
      const key = dayKeyOf(ts);
      if (key) (map[key] = map[key] || []).push(item);
    };
    state.events.forEach((e) => add(e.ts, { kind: 'symptom', t: e.ts, e }));
    state.visits.forEach((v) => {
      add(v.ts, { kind: 'visit', t: v.ts, v });
      add(v.follow_up, { kind: 'followup', t: v.follow_up, v });
    });
    state.meds.forEach((m) => add(m.start || m.ts, { kind: 'med', t: m.start || m.ts, m }));
    return map;
  }

  function monthCalendar(map) {
    const now = new Date();
    const cal = state.calMonth || { y: now.getFullYear(), m: now.getMonth() };
    const sel = state.calSel || { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
    const first = new Date(cal.y, cal.m, 1).getDay();
    const days = new Date(cal.y, cal.m + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<span class="cal-dow-slot"></span>';
    for (let d = 1; d <= days; d++) {
      const key = `${cal.y}-${cal.m + 1}-${d}`;
      const items = map[key] || [];
      const kinds = KINDS.filter((k) => items.some((x) => x.kind === k));
      const isToday = cal.y === now.getFullYear() && cal.m === now.getMonth() && d === now.getDate();
      const isSel = sel && sel.y === cal.y && sel.mo === cal.m + 1 && sel.d === d;
      cells += `<button class="cal-day${isToday ? ' today' : ''}${isSel ? ' sel' : ''}"
        data-day="${cal.y}-${cal.m + 1}-${d}" aria-label="${cal.y}-${cal.m + 1}-${d}: ${
        items.length ? items.length + ' recorded' : 'nothing'}">${d}${
        kinds.length ? `<span class="cal-dots">${kinds.map((k) => `<i class="dot ${k}"></i>`).join('')}</span>` : ''}</button>`;
    }
    const selItems = (map[`${sel.y}-${sel.mo}-${sel.d}`] || [])
      .sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const wd = WD[new Date(sel.y, sel.mo - 1, sel.d).getDay()];
    const boxes = SEL_KINDS.map((kind) => {
      const items = selItems.filter((x) => x.kind === kind);
      const rows = items.map((it) => {
        const time = fmtTs(it.t).split(' ')[1] || '';
        const [title, sub] = it.kind === 'symptom'
          ? [esc(it.e.quality || 'Symptom'), esc(it.e.body_location || '') + (it.e.severity !== undefined && it.e.severity !== null ? ' · severity ' + it.e.severity : '')]
          : it.kind === 'visit'
            ? [esc(it.v.clinician || 'Office Visit'), esc(it.v.specialty || '')]
            : [esc(it.m.name || 'Medication'), esc(it.m.dose || '')];
        return `<li class="ev"><i class="mini ${kind}" aria-hidden="true"></i><b>${title}</b><span>${sub}</span><time>${time}</time></li>`;
      }).join('');
      return `
        <div class="day-box ${kind}${items.length ? '' : ' empty'}">
          <h3>${GROUP_TITLES[kind]}${items.length ? `<span class="ev-count">${items.length}</span>` : ''}</h3>
          ${items.length ? `<ul class="ev-list">${rows}</ul>` : '<p class="day-none">Nothing recorded</p>'}
        </div>`;
    }).join('');
    return `
      <div class="panel cal-panel">
        <div class="cal-head">
          <h2>${MONTHS[cal.m]} ${cal.y}</h2>
          <div class="cal-nav">
            <button class="btn" data-cal="prev" aria-label="Previous month">‹</button>
            <button class="btn" data-cal="next" aria-label="Next month">›</button>
          </div>
        </div>
        <div class="cal-grid">
          ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => `<span class="cal-dow">${x}</span>`).join('')}
          ${cells}
        </div>
        <div class="cal-sel">
          <div class="cal-sel-head">${wd}, ${MON[sel.mo - 1]} ${sel.d}</div>
          ${boxes}
        </div>
      </div>`;
  }

  const isUpcoming = (v) => v.ts && new Date(v.ts) >= new Date();

  function viewOverview() {
    const ev = state.events;
    const upcoming = state.visits.filter(isUpcoming);
    const total = ev.length;
    const withSeverity = ev.filter((e) => e.severity !== null && e.severity !== undefined);
    const avgSeverity = withSeverity.length
      ? (withSeverity.reduce((sum, e) => sum + e.severity, 0) / withSeverity.length).toFixed(1)
      : '-';
    const last7 = ev.filter((e) => e.ts && Date.now() - new Date(e.ts).getTime() < 7 * 864e5).length;
    const deviceId = window.vexoAuth.deviceId();
    return `
      <div class="stats">
        <div class="stat"><div class="num">${total}</div><div class="lbl">Symptoms logged</div>
          <div class="sub">${last7} in the last 7 days</div></div>
        <div class="stat"><div class="num">${state.visits.length}</div><div class="lbl">Visits</div></div>
        <div class="stat"><div class="num">${state.meds.length}</div><div class="lbl">Medications</div></div>
        <div class="stat"><div class="num">${avgSeverity}<span class="unit">/10</span></div>
          <div class="lbl">Average severity</div>
          <div class="sub">${withSeverity.length} rated</div></div>
        <div class="stat"><div class="num">${upcoming.length}</div><div class="lbl">Upcoming visits</div></div>
        <div class="stat"><div class="num" style="font-size:13px;word-break:break-all">${esc(deviceId || '-')}</div>
          <div class="lbl">This device</div></div>
      </div>
      ${monthCalendar(itemsByDay())}`;
  }

  // the full record, field by field: what the API stored plus how it was made
  function recordDetail(e) {
    const field = (k, v) => {
      const shown = v === null || v === undefined || v === ''
        ? '<span class="null">null</span>' : esc(v);
      return `<div class="field-row"><code>${k}</code><span>${shown}</span></div>`;
    };
    const group = (title, pairs) => `
      <div class="field-group"><h3>${title}</h3>
        ${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => field(k, v)).join('')}
      </div>`;
    const pipeline = [
      ['transcript_model', e.transcript_model],
      ['extract_model', e.extract_model],
      ['audio_seconds', e.audio_seconds],
      ['source', e.source],
      ['schema_version', e.schema_version],
    ];
    const clinical = [
      ['body_location', e.body_location],
      ['quality', e.quality],
      ['severity', e.severity],
      ['activity', e.activity],
    ];
    const known = new Set(['id', 'ts', 'verbatim_quote', 'transcript_model', 'extract_model',
      'audio_seconds', 'source', 'schema_version', 'body_location', 'quality', 'severity',
      'activity', 'device', 'sealed', 'nonce', 'ct']);
    const extra = Object.entries(e).filter(([k]) => !known.has(k));
    return `
      <div class="panel detail" id="detail">
        <div class="detail-head">
          <h2>${esc(e.id || 'record')}</h2>
          <button class="btn" data-close="1">Close</button>
        </div>
        ${group('Identity', [['id', e.id], ['ts', e.ts], ['device', e.device]])}
        ${group('Statement', [['verbatim_quote', e.verbatim_quote]])}
        ${group('Structured fields', clinical)}
        ${group('Processing', pipeline)}
        ${extra.length ? group('Other', extra) : ''}
        <div class="field-group"><h3>Sealed payload</h3>
          <p class="muted small">Stored on the server as ciphertext (AES-GCM, additional data = device id).
             The fields above are what this browser decrypted from it.</p>
        </div>
      </div>`;
  }

  function viewRecords() {
    const filter = state.filter.toLowerCase();
    const rows = state.events
      .filter((e) => !filter || [e.verbatim_quote, e.body_location, e.quality,
        e.activity, e.severity].filter((v) => v !== undefined && v !== null)
        .join(' ').toLowerCase().includes(filter))
      .sort((a, b) => ((b.ts || '') > (a.ts || '') ? 1 : -1));
    const size = state.pageSize;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(Math.max(1, state.page), pages);
    state.page = page;
    const shown = rows.slice((page - 1) * size, page * size);
    const line = (e) => `
        <div class="log-row row-open${state.freshIds.has(e.id) ? ' fresh' : ''}${state.openId === e.id ? ' open' : ''}"
          data-open="${esc(e.id)}" role="button" tabindex="0">
          <span class="ts">${fmtTs(e.ts)}</span>
          <span class="kind">${KIND_LABELS[e.kind] || KIND_LABELS.Observation}</span>
          <span class="sev ${sevClass(e.severity)}">${e.severity === null || e.severity === undefined ? '-' : 'severity ' + e.severity}</span>
          <span class="msg">${esc(e.verbatim_quote || '')}</span>
          <span class="loc">${window.vexoBody.bodyFigure(e.body_location)}${esc(e.body_location || '-')}</span>
          <span class="q">${esc(e.quality || '-')}</span>
          <span class="act">${esc(e.activity || '-')}</span>
        </div>`;
    const pager = `
      <div class="pager">
        <div class="pager-controls">
          <button class="btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
          ${pageNumbers(page, pages)}
          <button class="btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button>
        </div>
      </div>`;
    return `
      <div class="logbar">
        <input class="search" id="filter" placeholder="Filter logs (text, body part, severity…)"
          value="${esc(state.filter)}" aria-label="Filter logs">
        <span class="muted small">${rows.length} of ${state.events.length}</span>
        <div class="per-page">
          <span>Rows</span>
          <button class="drop-toggle" id="page-size-toggle" aria-haspopup="listbox"
            aria-expanded="${state.rowsOpen ? 'true' : 'false'}">${size}<span class="chev" aria-hidden="true"></span></button>
          ${state.rowsOpen ? `<ul class="drop-menu" role="listbox" id="page-size-menu">
            ${[10, 25, 50, 100].map((n) => `<li role="option" aria-selected="${n === size}" data-size="${n}" class="${n === size ? 'on' : ''}">${n}</li>`).join('')}
          </ul>` : ''}
        </div>
      </div>
      <div class="log">
        <div class="log-row head">
          <span class="ts-h">Timestamp</span><span>Type</span><span>Severity</span><span>Message</span>
          <span>Body location</span><span>Quality</span><span>Activity</span>
        </div>
        ${shown.map(line).join('') || '<div class="log-empty">No logs match.</div>'}
        ${state.openId ? recordDetail(state.events.find((e) => e.id === state.openId) || {}) : ''}
      </div>
      ${rows.length > size ? pager : ''}`;
  }

  // page numbers around the current page, with gaps for long lists
  function pageNumbers(page, pages) {
    const wanted = new Set([1, pages, page - 1, page, page + 1]);
    const nums = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    let out = '';
    let prev = 0;
    for (const n of nums) {
      if (n - prev > 1) out += '<span class="gap">…</span>';
      out += `<button class="btn num${n === page ? ' on' : ''}" data-page="${n}">${n}</button>`;
      prev = n;
    }
    return out;
  }

  // ---------- export: a decision tree, then a plain answer ----------
  //
  // Nobody outside health IT knows what a "FHIR Bundle" is, so the user is
  // asked two simple questions (who reads it, where they are) and we offer the
  // format that fits.

  const FMT_TONES = { CSV: 'csv', JSON: 'json', 'FHIR Bundle': 'fhir', 'IPS document': 'ips' };

  const EXPORT_FORMATS = {
    csv: {
      name: 'Spreadsheet', ext: 'CSV', url: '/export/csv',
      plain: 'One row per entry (date, body part, how it felt, severity, activity, what you said) for a spreadsheet or a quick look yourself.',
    },
    fhir: {
      name: 'Clinical record', ext: 'FHIR Bundle', url: '/export/fhir',
      plain: 'The full clinical record a clinician or a hospital system can import: symptoms, visits, messages and medications.',
    },
    ips: {
      name: 'Patient summary', ext: 'IPS document', url: '/export/ips',
      plain: 'A short summary of the most important findings, for a doctor who needs the essentials fast - what you hand over first.',
    },
    form: {
      name: 'Intake form', ext: 'JSON', url: '/api/form',
      plain: 'The chief complaint and history draft the doctor you are about to see reviews before the visit.',
    },
  };

  const REGIONS = [
    { value: 'us', label: 'United States', order: ['fhir', 'ips'] },
    { value: 'eu', label: 'Europe', order: ['ips', 'fhir'] },
    { value: 'other', label: 'Somewhere else', order: ['ips', 'fhir'] },
    { value: 'unsure', label: 'I do not know', order: ['ips', 'fhir'] },
  ];

  let exportAnswers = null;
  const defaultExport = () => ({ recipient: 'me', region: 'us', intent: 'keep', showAlternatives: false });

  function formatCard(key, primary) {
    const f = EXPORT_FORMATS[key];
    return `
      <div class="card">
        <h3>${f.name}<span class="fmt" data-fmt="${FMT_TONES[f.ext] || 'other'}">${f.ext}</span></h3>
        <p>${f.plain}</p>
        <div class="card-foot">
          <a class="btn${primary ? ' primary' : ''}" href="${ORIGIN}${f.url}" download>Download</a>
        </div>
      </div>`;
  }

  function questionRow(name, question, options, current) {
    const buttons = options.map((o) => `
      <button class="choice${o.value === current ? ' on' : ''}" data-q="${name}" data-value="${o.value}">${o.label}</button>`
    ).join('');
    return `<div class="question"><div class="q-label">${question}</div>
      <div class="choices">${buttons}</div></div>`;
  }

  function visitCard(v, showTag) {
    const when = fmtTs(v.ts);
    return `
      <li class="rec-card">
        <div class="rec-when"><b>${when.split(' ')[0]}</b><span>${when.split(' ')[1] || ''}</span></div>
        <div class="rec-main">
          <div class="rec-title">${esc(v.clinician || 'Office Visit')}<span class="rec-tag">${esc(v.specialty || '')}</span></div>
          ${v.reason ? `<p class="rec-sub">${esc(v.reason)}</p>` : ''}
          ${v.summary ? `<p class="rec-sub">${esc(v.summary)}</p>` : ''}
          ${(v.instructions || []).length ? `<ol class="rec-list">${v.instructions.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
          ${v.follow_up ? `<p class="rec-foot">Follow-up: ${esc(v.follow_up)}</p>` : ''}
        </div>
      </li>`;
  }

  function viewVisits() {
    const upcoming = state.visits.filter((v) => v.ts && new Date(v.ts) >= new Date());
    const past = state.visits.filter((v) => !v.ts || new Date(v.ts) < new Date());
    const group = (title, list) => (list.length ? `
      <div class="rec-section"><h2>${title}</h2>
        <ul class="rec-list-cards">${list.map((v) => visitCard(v)).join('')}</ul></div>` : '');
    return `
      ${group('Upcoming', upcoming)}
      ${group('Past', past)}
      ${state.visits.length ? '' : '<div class="panel"><p class="muted small">No visits on file yet.</p></div>'}
      ${state.visits.length && !past.length && !upcoming.length ? '' : ''}`;
  }

  // today's dose state for a medication: taken / due / missed
  function doseState(m) {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    return (m.times || []).slice().sort().map((t) => {
      const [h, mi] = String(t).split(':').map(Number);
      const at = h * 60 + (mi || 0);
      return { t, state: at < mins ? 'missed' : 'due', at };
    });
  }

  function medCard(m) {
    const doses = doseState(m);
    const reviewed = Boolean(m.confirmed_at);
    return `
      <li class="rec-card${reviewed ? '' : ' to-review'}">
        <div class="rec-main">
          <div class="rec-title">${esc(m.name || 'Medication')}<span class="rec-tag">${esc(m.dose || '')}</span>
            ${reviewed ? '' : '<button class="btn" data-review="' + esc(m.id) + '">Review</button>'}</div>
          ${m.instructions ? `<p class="rec-sub">${esc(m.instructions)}</p>` : ''}
          <div class="dose-chips">
            ${doses.length ? doses.map((d) => `<span class="dose-chip ${d.state}">${d.t}</span>`).join('')
              : '<span class="dose-chip asneeded">as needed</span>'}
          </div>
        </div>
      </li>`;
  }

  function viewMedications() {
    const toReview = state.meds.filter((m) => !m.confirmed_at);
    const reviewed = state.meds.filter((m) => m.confirmed_at);
    return `
      ${toReview.length ? `<div class="rec-section"><h2>To review (${toReview.length})</h2>
        <ul class="rec-list-cards">${toReview.map(medCard).join('')}</ul></div>` : ''}
      ${reviewed.length ? `<div class="rec-section"><h2>Current medications</h2>
        <ul class="rec-list-cards">${reviewed.map(medCard).join('')}</ul></div>` : ''}
      ${state.meds.length ? '' : '<div class="panel"><p class="muted small">No medications on file yet.</p></div>'}`;
  }

  function viewExport() {
    exportAnswers = exportAnswers || defaultExport();
    const a = exportAnswers;
    const recipient = questionRow('recipient', 'Who are these records for?', [
      { value: 'me', label: 'Myself: keeping track' },
      { value: 'other', label: 'Someone else: a doctor or a clinic' },
    ], a.recipient);

    if (a.recipient === 'me') {
      const intent = questionRow('intent', 'What will you do with them?', [
        { value: 'keep', label: 'Keep them for my own records' },
        { value: 'look', label: 'Look at them / make a chart' },
        { value: 'tool', label: 'Feed them into another tool' },
      ], a.intent);
      const pick = { keep: 'csv', look: 'csv', tool: 'form' }[a.intent];
      return `
        <div class="panel questionnaire">
          ${recipient}
          ${intent}
        </div>
        <div class="answer">
          ${formatCard(pick, true)}
        </div>`;
    }

    const region = questionRow('region', 'Where is the doctor or clinic?', REGIONS, a.region);
    const chosen = REGIONS.find((r) => r.value === a.region);
    const primary = chosen.order[0];
    const second = chosen.order[1];
    return `
      <div class="panel questionnaire">
        ${recipient}
        ${region}
      </div>
      <div class="answer">
        ${formatCard(primary, true)}
        ${formatCard('form')}
        <div class="more">
          <button class="btn" data-toggle="alternatives">${a.showAlternatives ? 'Hide' : 'Show'} other formats</button>
        </div>
        ${a.showAlternatives ? `<div class="cards alt">${formatCard(second)}
          ${formatCard('csv')}</div>` : ''}
      </div>`;
  }

  function viewSettings() {
    const deviceId = window.vexoAuth.deviceId();
    return `
      <div class="panel">
        <h2>Devices</h2>
        <p>Your records can only be read from the devices you have added.</p>
        <ul class="devices">
          <li>
            <span class="name">This browser</span>
            <span class="muted small" style="font-family:var(--mono)">${esc(deviceId || 'no key')}</span>
            <span class="pill current">current</span>
          </li>
          <li>
            <span class="name">Vexo band</span>
            <span class="muted small">where your logs come from</span>
            <span class="pill">paired</span>
          </li>
        </ul>
      </div>
      <div class="panel">
        <h2>Add device</h2>
        <p>Open this page on the new device and enter this pairing code. After that it can
           read your records too.</p>
        <div class="pair">
          <code class="pair-code" id="pair-code">-</code>
          <button class="btn" id="pair-new">New code</button>
          <span class="ttl" id="pair-ttl"></span>
        </div>
      </div>`;
  }

  function render() {
    renderStatus();
    const views = { overview: viewOverview, records: viewRecords, visits: viewVisits,
      medications: viewMedications, export: viewExport, settings: viewSettings };
    els.content.innerHTML = (state.loaded || state.offline
      ? (views[state.view] || viewOverview)()
      : '<div class="log"><div class="log-empty">Decrypting your records…</div></div>');
    els.title.textContent = { overview: 'Overview', records: 'Records', visits: 'Visits',
      medications: 'Medications', export: 'Export', settings: 'Settings' }[state.view];
    for (const btn of els.nav.querySelectorAll('.nav-item')) {
      btn.classList.toggle('active', btn.dataset.view === state.view);
    }
    wireViewEvents();
  }

  function wireViewEvents() {
    for (const btn of els.content.querySelectorAll('[data-cal]')) {
      btn.onclick = () => {
        const now = new Date();
        const cal = state.calMonth || { y: now.getFullYear(), m: now.getMonth() };
        const step = btn.dataset.cal === 'prev' ? -1 : 1;
        let m = cal.m + step;
        let y = cal.y;
        if (m < 0) { m = 11; y -= 1; }
        if (m > 11) { m = 0; y += 1; }
        state.calMonth = { y, m };
        render();
      };
    }
    for (const btn of els.content.querySelectorAll('[data-day]')) {
      btn.onclick = () => {
        const [y, mo, d] = btn.dataset.day.split('-').map(Number);
        state.calSel = { y, mo, d };
        render();
      };
    }
    for (const btn of els.content.querySelectorAll('[data-review]')) {
      btn.onclick = async () => {
        const med = state.meds.find((m) => m.id === btn.dataset.review);
        if (!med) return;
        const now = new Date();
        const iso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
          + '-' + String(now.getDate()).padStart(2, '0') + 'T'
          + [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
        const sealed = await window.vexoAuth.sealEvent({ ...med, confirmed_at: iso, confirmed_by: 'patient' });
        await fetch(ORIGIN + '/MedicationRequest', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...window.vexoAuth.headers() },
          body: JSON.stringify(sealed),
        });
        await loadRecords();
      };
    }
    for (const btn of els.content.querySelectorAll('.choice')) {
      btn.onclick = () => {
        exportAnswers = exportAnswers || defaultExport();
        exportAnswers[btn.dataset.q] = btn.dataset.value;
        render();
      };
    }
    const toggle = els.content.querySelector('[data-toggle="alternatives"]');
    if (toggle) {
      toggle.onclick = () => {
        exportAnswers.showAlternatives = !exportAnswers.showAlternatives;
        render();
      };
    }
    const filter = els.content.querySelector('#filter');
    if (filter) filter.oninput = () => { state.filter = filter.value; state.page = 1; render(); };
    const sizeToggle = els.content.querySelector('#page-size-toggle');
    if (sizeToggle) {
      sizeToggle.onclick = () => { state.rowsOpen = !state.rowsOpen; render(); };
      for (const opt of els.content.querySelectorAll('#page-size-menu [data-size]')) {
        opt.onclick = () => {
          state.pageSize = Number(opt.dataset.size);
          state.page = 1;
          state.rowsOpen = false;
          render();
        };
      }
    }
    for (const row of els.content.querySelectorAll('[data-open]')) {
      const open = () => {
        state.openId = state.openId === row.dataset.open ? null : row.dataset.open;
        render();
      };
      row.onclick = open;
      row.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    }
    const close = els.content.querySelector('[data-close]');
    if (close) close.onclick = () => { state.openId = null; render(); };
    for (const btn of els.content.querySelectorAll('[data-page]')) {
      btn.onclick = () => {
        if (btn.disabled) return;
        state.page = Number(btn.dataset.page);
        render();
      };
    }
    const pairNew = els.content.querySelector('#pair-new');
    if (pairNew) {
      pairNew.onclick = () => {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        els.content.querySelector('#pair-code').textContent = code.slice(0, 3) + ' ' + code.slice(3);
        const ttl = els.content.querySelector('#pair-ttl');
        let left = 60;
        ttl.textContent = left + 's left';
        clearInterval(pairNew.timer);
        pairNew.timer = setInterval(() => {
          left -= 1;
          ttl.textContent = left > 0 ? left + 's left' : 'expired';
          if (left <= 0) clearInterval(pairNew.timer);
        }, 1000);
      };
    }
  }

  // ---------- shell ----------

  function setView(view) {
    state.view = view;
    saveView(view);
    render();
  }

  function wireShell() {
    els.nav.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.nav-item');
      if (btn) setView(btn.dataset.view);
    });
    // one toggle: the chevron flips and the sidebar folds both ways
    const wide = () => window.innerWidth > 720;
    els.toggle.onclick = () => {
      const folded = els.sidebar.classList.toggle('collapsed');
      els.toggle.setAttribute('aria-expanded', String(!folded));
      els.toggle.title = folded ? 'Expand sidebar' : 'Collapse sidebar';
      els.toggle.setAttribute('aria-label', els.toggle.title);
      els.toggle.querySelector('.chevron').textContent = folded ? '›' : '‹';
    };
    els.toggle.hidden = !wide();
    window.addEventListener('resize', () => { els.toggle.hidden = !wide(); });
    els.status.addEventListener('click', () => {
      if (statusOf() === 'nokey') window.vexoAuth.showUnlock();
    });
    window.addEventListener('vexo-unlocked', () => {
      state.offline = false;
      if (window.vexoAuth.isUnlocked()) safeLoadRecords(); else render();
    });
  }

  async function start() {
    wireShell();
    render();
    window.vexoAuth.onChange(() => { renderStatus(); });
    // silent attempt at the local bridge; the user does nothing when it works
    const found = await window.vexoAuth.autoUnlock();
    if (!found) { render(); return; }
    safeLoadRecords();
    startPolling();
  }

  start();
})();
