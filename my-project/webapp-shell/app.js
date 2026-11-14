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
    deviceId: document.getElementById('device-id'),
    footDevice: document.getElementById('foot-device'),
    sidebar: document.getElementById('sidebar'),
    collapse: document.getElementById('collapse'),
    expand: document.getElementById('expand'),
  };

  const state = {
    view: 'overview',
    events: [],
    offline: false,
    loaded: false,
    filter: '',
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

  async function loadRecords() {
    const sealedRows = await api('/Observation');
    state.events = await window.vexoAuth.decryptRows(sealedRows);
    state.loaded = true;
    render();
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
      nokey: 'Offline — no key',
    };
    els.status.dataset.state = s;
    els.status.querySelector('.status-label').textContent = labels[s];
    els.hint.hidden = s !== 'nokey' && s !== 'offline';
    if (s === 'nokey') {
      els.hint.innerHTML = 'No device key found on this machine. Records stay sealed without it. '
        + 'Start the local bridge with <code>' + BRIDGE_HINT + '</code>, or paste your key — '
        + 'from another device, open Settings → Pair a device.';
    } else if (s === 'offline') {
      els.hint.textContent = 'The records server did not answer. Check that it is running, then retry.';
    }
    const id = window.vexoAuth.deviceId();
    els.deviceId.textContent = id ? 'device ' + id : '';
    els.footDevice.textContent = id ? 'device ' + id : '';
    els.deviceId.hidden = !id;
  }

  // ---------- views ----------

  function fmtTs(ts) {
    if (!ts) return '—';
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

  function viewOverview() {
    const ev = state.events;
    const total = ev.length;
    const withSeverity = ev.filter((e) => e.severity !== null && e.severity !== undefined);
    const avgSeverity = withSeverity.length
      ? (withSeverity.reduce((sum, e) => sum + e.severity, 0) / withSeverity.length).toFixed(1)
      : '—';
    const last7 = ev.filter((e) => e.ts && Date.now() - new Date(e.ts).getTime() < 7 * 864e5).length;
    const locations = new Set(ev.map((e) => e.body_location).filter(Boolean));
    const latest = ev.reduce((best, e) => ((e.ts || '') > (best.ts || '') ? e : best), {});
    const deviceId = window.vexoAuth.deviceId();
    return `
      <div class="stats">
        <div class="stat"><div class="num">${total}</div><div class="lbl">Total logs</div>
          <div class="sub">${last7} in the last 7 days</div></div>
        <div class="stat"><div class="num">${avgSeverity}</div><div class="lbl">Average severity</div>
          <div class="sub">0–10 scale · ${withSeverity.length} rated</div></div>
        <div class="stat"><div class="num">${locations.size}</div><div class="lbl">Body locations</div>
          <div class="sub">${[...locations].slice(0, 4).map(esc).join(', ') || 'none recorded'}</div></div>
        <div class="stat"><div class="num">${latest.ts ? fmtTs(latest.ts).split(' ')[0] : '—'}</div>
          <div class="lbl">Latest entry</div>
          <div class="sub">${latest.ts ? fmtTs(latest.ts).split(' ')[1] : 'no entries yet'}</div></div>
        <div class="stat"><div class="num" style="font-size:14px;font-family:var(--mono);word-break:break-all">${esc(deviceId || '—')}</div>
          <div class="lbl">This device</div>
          <div class="sub">${window.vexoAuth.isUnlocked() ? 'key loaded' : 'no key'}</div></div>
      </div>`;
  }

  function viewRecords() {
    const filter = state.filter.toLowerCase();
    const rows = state.events
      .filter((e) => !filter || JSON.stringify(e).toLowerCase().includes(filter))
      .sort((a, b) => ((b.ts || '') > (a.ts || '') ? 1 : -1));
    const body = rows.map((e) => {
      const sev = e.severity;
      return `
        <div class="log-row">
          <span class="ts">${fmtTs(e.ts)}</span>
          <span class="kind">obs</span>
          <span class="sev ${sevClass(sev)}">${sev === null || sev === undefined ? '—' : 'sev ' + sev}</span>
          <span class="msg">${esc(e.verbatim_quote || '')}
            <em>${esc([e.body_location, e.quality, e.activity].filter(Boolean).join(' · '))}</em></span>
        </div>`;
    }).join('');
    return `
      <div class="logbar">
        <input class="search" id="filter" placeholder="Filter logs (text, body part, severity…)"
          value="${esc(state.filter)}" aria-label="Filter logs">
        <span class="muted small">${rows.length} of ${state.events.length}</span>
      </div>
      <div class="log">
        <div class="log-row head">
          <span class="ts-h">Timestamp</span><span>Kind</span><span>Severity</span><span>Message</span>
        </div>
        ${body || '<div class="log-empty">No logs match.</div>'}
      </div>`;
  }

  function viewExport() {
    const card = (title, fmt, desc, url, primary) => `
      <div class="card">
        <h3>${title}<span class="fmt">${fmt}</span></h3>
        <p>${desc}</p>
        <div class="card-foot">
          <span class="url">${url}</span>
          <a class="btn${primary ? ' primary' : ''}" href="${ORIGIN}${url}">Download</a>
        </div>
      </div>`;
    return `
      <div class="cards">
        ${card('Raw events', 'JSON', 'The contract events exactly as recorded — the native shape everything else is derived from.', '/export/json', true)}
        ${card('Timeline', 'CSV', 'One row per symptom event: id, time, body part, quality, severity, activity, quote. Opens in any spreadsheet.', '/export/csv')}
        ${card('Clinical Bundle', 'FHIR', 'HL7 FHIR Bundle: Observation + Provenance per event, plus Encounter, Communication and Medication resources.', '/export/fhir')}
        ${card('Patient Summary', 'IPS', 'International Patient Summary-style extract — the compact document for handing to a clinician.', '/export/ips')}
        ${card('Intake form', 'JSON', 'The doctor-facing draft built from the entry with the most clinical signal (chief complaint, HPI, severity).', '/api/form')}
      </div>`;
  }

  function viewSettings() {
    const deviceId = window.vexoAuth.deviceId();
    return `
      <div class="panel">
        <h2>Devices</h2>
        <p>Your records are sealed to a key that never leaves its device. Each device holds its own key.</p>
        <ul class="devices">
          <li>
            <span class="name">This browser</span>
            <span class="muted small" style="font-family:var(--mono)">${esc(deviceId || 'no key')}</span>
            <span class="pill current">current</span>
          </li>
          <li>
            <span class="name">Vexo band</span>
            <span class="muted small">source device · signs the logs it sends</span>
            <span class="pill">paired</span>
          </li>
        </ul>
      </div>
      <div class="panel">
        <h2>Add device</h2>
        <p>Open the records page on the new device with this pairing code. The new device
           derives its own key and is added to your vault — nothing to type by hand.</p>
        <div class="pair">
          <code class="pair-code" id="pair-code">—</code>
          <button class="btn" id="pair-new">New code</button>
          <span class="ttl" id="pair-ttl"></span>
        </div>
        <p class="muted small" style="margin-top:10px">Demo: the code is local-only and expires in a minute.</p>
      </div>`;
  }

  function render() {
    renderStatus();
    const views = { overview: viewOverview, records: viewRecords, export: viewExport, settings: viewSettings };
    els.content.innerHTML = (state.loaded || state.offline
      ? (views[state.view] || viewOverview)()
      : '<div class="log"><div class="log-empty">Decrypting your records…</div></div>');
    els.title.textContent = { overview: 'Overview', records: 'Records', export: 'Export', settings: 'Settings' }[state.view];
    for (const btn of els.nav.querySelectorAll('.nav-item')) {
      btn.classList.toggle('active', btn.dataset.view === state.view);
    }
    wireViewEvents();
  }

  function wireViewEvents() {
    const filter = els.content.querySelector('#filter');
    if (filter) filter.oninput = () => { state.filter = filter.value; render(); };
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
    render();
  }

  function wireShell() {
    els.nav.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.nav-item');
      if (btn) setView(btn.dataset.view);
    });
    // sidebar collapse only means anything on wide screens
    const wide = () => window.innerWidth > 720;
    els.collapse.onclick = () => {
      els.sidebar.classList.add('collapsed');
      els.expand.hidden = false;
    };
    els.expand.onclick = () => {
      els.sidebar.classList.remove('collapsed');
      els.expand.hidden = true;
    };
    els.collapse.hidden = !wide();
    window.addEventListener('resize', () => {
      if (wide()) els.sidebar.classList.remove('collapsed');
      els.collapse.hidden = !wide();
      els.expand.hidden = true;
    });
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
  }

  start();
})();
