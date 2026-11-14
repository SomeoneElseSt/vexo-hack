// Device unlock for the symptom log. The records on the VM are sealed with a
// key that never leaves the patient's device, so this file is what turns
// ciphertext into readable events - in the browser, with WebCrypto.
//
// Where the key comes from, in order:
//   1. the local bridge on this machine (http://127.0.0.1:8768/session), or
//   2. the user pastes the key file content once.
// The raw secret is never sent anywhere; only derived values are used.
'use strict';

(function () {
  const BRIDGE = 'http://127.0.0.1:8768';
  const AUTH_LABEL = 'vexo-auth/v1';
  const KDF_SALT = 'vexo-records/v1';
  const KDF_INFO = 'aes-gcm';

  const state = { deviceId: null, auth: null, aesKey: null, modal: null };
  const listeners = new Set();

  function notify() { for (const fn of listeners) fn(state); }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  // ---------- key derivation (same scheme as device_crypto.py) ----------

  async function deriveFromSecret(secretBytes) {
    const sha = await crypto.subtle.digest('SHA-256', secretBytes);
    // base32(sha256(secret))[:16], lowercase - device id
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bytes = new Uint8Array(sha);
    let bits = 0, value = 0, b32 = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        b32 += A[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) b32 += A[(value << (5 - bits)) & 31];
    const deviceId = b32.toLowerCase().slice(0, 16);

    const hmacKey = await crypto.subtle.importKey(
      'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const authBytes = new Uint8Array(
      await crypto.subtle.sign('HMAC', hmacKey, enc.encode(AUTH_LABEL)));
    const authHex = Array.from(authBytes).map((x) => x.toString(16).padStart(2, '0')).join('');

    const material = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
    const aesBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(KDF_SALT), info: enc.encode(KDF_INFO) },
      material, 256);
    const aesKey = await crypto.subtle.importKey(
      'raw', aesBits, { name: 'AES-GCM' }, false, ['decrypt', 'encrypt']);

    return { deviceId, auth: authHex, aesKey };
  }

  function apply(session) {
    state.deviceId = session.device_id || session.deviceId;
    state.auth = session.auth;
    state.aesKey = session.aesKey;
    notify();
  }

  // ---------- sources ----------

  async function fromBridge() {
    try {
      const res = await fetch(BRIDGE + '/session', { cache: 'no-store' });
      if (!res.ok) return false;
      const s = await res.json();
      const aesKey = await crypto.subtle.importKey(
        'raw', b64ToBytes(s.aes_key), { name: 'AES-GCM' }, false, ['decrypt', 'encrypt']);
      apply({ device_id: s.device_id, auth: s.auth, aesKey });
      return true;
    } catch (_) {
      return false;
    }
  }

  function fromPaste(secretText) {
    // accepts a plain hex/base64 secret or JSON {"secret": "..."}
    let raw = secretText.trim();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.secret === 'string') raw = parsed.secret;
    } catch (_) { /* not json: treat as the raw secret */ }
    let bytes;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      bytes = new Uint8Array(raw.match(/.{2}/g).map((h) => parseInt(h, 16)));
    } else {
      bytes = b64ToBytes(raw);
    }
    return deriveFromSecret(bytes).then((s) => { apply(s); return true; });
  }

  // ---------- record access ----------

  function localIso(date) {
    // the patient's own clock and offset are clinical context: never UTC "Z"
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    const off = -date.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      + `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
  }

  async function decryptOne(row) {
    if (!row || row.sealed !== true) return row;   // already plain
    if (!state.aesKey) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBytes(row.nonce),
          additionalData: enc.encode(state.deviceId) },
        state.aesKey, b64ToBytes(row.ct));
      return JSON.parse(dec.decode(plain));
    } catch (_) {
      return null;   // another device's record, or tampered with
    }
  }

  async function sealEvent(event) {
    if (!state.aesKey) throw new Error('locked: no device key');
    const id = event.id || ('evt-' + Date.now());
    const full = { ...event, id, ts: event.ts || localIso(new Date()) };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(state.deviceId) },
      state.aesKey, enc.encode(JSON.stringify(full)));
    return {
      event: { id, device: state.deviceId },
      sealed: { nonce: bytesToB64(iv), ct: bytesToB64(ct) },
    };
  }

  // ---------- unlock UI (reuses the .modal class from style.css) ----------

  function showUnlock(onDone) {
    if (state.modal) return;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-card">
        <h2>Unlock your records</h2>
        <p class="muted">Your records are sealed with a key that never leaves your device.
           Start the local bridge on this machine, or paste your key.</p>
        <p class="muted small">Start it with:
          <code>python my-project/local_bridge.py --allow ${location.origin}</code></p>
        <label class="field">Key
          <input id="unlock-key" type="password" placeholder="paste your device key">
        </label>
        <p id="unlock-msg" class="muted"></p>
        <div class="modal-actions">
          <button id="unlock-try">Try local bridge</button>
          <button id="unlock-paste" class="primary">Unlock with key</button>
          <button id="unlock-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    state.modal = modal;
    const msg = (t) => { modal.querySelector('#unlock-msg').textContent = t; };
    const close = () => {
      modal.remove();
      state.modal = null;
      window.dispatchEvent(new Event('vexo-unlocked'));
      if (onDone) onDone();
    };

    modal.querySelector('#unlock-try').onclick = async () => {
      msg('Looking for the local bridge…');
      if (await fromBridge()) { close(); return; }
      msg('No local bridge on this machine. Start it with the command above, or paste your key.');
    };
    modal.querySelector('#unlock-paste').onclick = async () => {
      const value = modal.querySelector('#unlock-key').value;
      if (!value.trim()) { msg('Paste your key first.'); return; }
      try {
        await fromPaste(value);
        close();
      } catch (_) {
        msg('That key did not work - check it and try again.');
      }
    };
    modal.querySelector('#unlock-cancel').onclick = () => { modal.remove(); state.modal = null; };
  }

  // ---------- the interface app.js expects ----------

  window.vexoAuth = {
    isUnlocked: () => Boolean(state.auth && state.aesKey),
    headers: () => (state.auth ? { 'X-Device-Auth': state.auth } : {}),
    deviceId: () => state.deviceId,
    decryptRows: async (rows) => {
      const out = [];
      for (const row of rows || []) {
        const e = await decryptOne(row);
        if (e !== null) out.push(e);
      }
      return out;
    },
    decryptForm: async (form) => (form && form.sealed === true ? decryptOne(form) : form),
    onChange: (fn) => { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    sealEvent,
    showUnlock,
    autoUnlock: () => fromBridge(),
  };
})();
