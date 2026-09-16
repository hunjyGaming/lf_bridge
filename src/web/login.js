'use strict';

// Login-Seite. Nutzt nur, was auch die Konsole nutzt: fetch + der
// HttpOnly-Session-Cookie, den /api/auth/login setzt.

const $ = (id) => document.getElementById(id);
const form = $('login-form');
const msgEl = $('login-msg');
const btn = $('login-btn');

let lockTimer = null;

function msg(text, bad) {
  msgEl.textContent = text;
  msgEl.classList.toggle('bad', !!bad);
  msgEl.hidden = !text;
}

function human(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} Sekunden`;
  return `${Math.ceil(s / 60)} Minuten`;
}

/** Sperre nach zu vielen Fehlversuchen: Knopf aus, Restzeit herunterzählen. */
function lockOut(ms) {
  clearInterval(lockTimer);
  let left = ms;
  btn.disabled = true;
  const tick = () => {
    left -= 1000;
    if (left <= 0) {
      clearInterval(lockTimer);
      lockTimer = null;
      btn.disabled = false;
      msg('');
      return;
    }
    msg(`Zu viele Fehlversuche. Nächster Versuch in ${human(left)}.`, true);
  };
  msg(`Zu viele Fehlversuche. Nächster Versuch in ${human(left)}.`, true);
  lockTimer = setInterval(tick, 1000);
}

let session = null;

async function check() {
  try {
    const res = await fetch('/api/auth/session', { headers: { Accept: 'application/json' } });
    const info = (await res.json())?.data;
    if (!info) return;
    session = info;
    if (info.setupPending) { location.replace('/setup'); return; }
    if (info.authenticated) { location.replace('/'); return; }
    if (!info.loginRequired) { location.replace('/'); return; }
    if (info.lockedForMs > 0) lockOut(info.lockedForMs);
    applyRecoveryState();
  } catch { /* Server noch nicht bereit — das Formular funktioniert trotzdem */ }
}

// ---------------- Passwort vergessen ----------------
// Der Code geht NUR über den Benachrichtigungskanal raus (Discord/ntfy/Mail) —
// nie über diese Antwort. Wer den Kanal nicht hat, kommt hier nicht weiter.
const recoverForm = $('recover-form');
const recoverMsg = $('recover-msg');

function rmsg(text, bad) {
  recoverMsg.textContent = text;
  recoverMsg.classList.toggle('bad', !!bad);
  recoverMsg.hidden = !text;
}

function applyRecoveryState() {
  const chans = (session && session.recoveryChannels) || [];
  const lead = $('recover-lead');
  if (session && session.passwordPinned) {
    lead.textContent = 'Das Passwort ist in der .env des Rechners festgelegt (LF_ADMIN_PASSWORD) — es lässt sich nur dort ändern.';
    $('send-code').disabled = true;
    $('recover-btn').disabled = true;
  } else if (!chans.length) {
    lead.textContent = 'Es ist kein Benachrichtigungskanal eingerichtet — es gibt keinen Weg, dir einen Code zu schicken. Am Hallen-PC hilft: Dienst stoppen, "npm run setpw", Dienst starten.';
    $('send-code').disabled = true;
  } else {
    lead.textContent = `Wir schicken dir einen Code über: ${chans.join(', ')}. Bis du ihn einlöst, gilt dein altes Passwort weiter.`;
    $('send-code').disabled = false;
  }
}

$('forgot').addEventListener('click', () => {
  form.hidden = true;
  recoverForm.hidden = false;
  applyRecoveryState();
});
$('back-to-login').addEventListener('click', () => {
  recoverForm.hidden = true;
  form.hidden = false;
});

$('send-code').addEventListener('click', async () => {
  $('send-code').disabled = true;
  rmsg('Sende …');
  try {
    const res = await fetch('/api/auth/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' }, body: '{}',
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      rmsg(`Code unterwegs an: ${(data.data.sentTo || []).join(', ')}. Gültig 15 Minuten.`);
      $('code').focus();
      return;
    }
    if (res.status === 429) rmsg(`Gerade schon einer verschickt — bitte ${Math.ceil((data?.retryAfterMs || 60000) / 1000)} Sekunden warten.`, true);
    else if (data?.error === 'no_channel') rmsg('Kein Benachrichtigungskanal eingerichtet.', true);
    else if (data?.error === 'pinned') rmsg('Das Passwort ist in der .env festgelegt.', true);
    else rmsg('Konnte nicht gesendet werden.', true);
  } catch {
    rmsg('Server nicht erreichbar.', true);
  }
  $('send-code').disabled = false;
});

recoverForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  const next = $('newpw').value;
  if (!code) return rmsg('Bitte den Code aus der Nachricht eintragen.', true);
  if (next.length < 8) return rmsg('Das neue Passwort braucht mindestens 8 Zeichen.', true);

  $('recover-btn').disabled = true;
  rmsg('Prüfe …');
  try {
    const res = await fetch('/api/auth/recover/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' },
      body: JSON.stringify({ code, next }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) { location.replace('/'); return; }
    if (res.status === 429) rmsg('Zu viele Fehlversuche — bitte später erneut.', true);
    else if (data?.error === 'bad_code') rmsg('Code stimmt nicht oder ist abgelaufen.', true);
    else rmsg(data?.hint || 'Hat nicht geklappt.', true);
  } catch {
    rmsg('Server nicht erreichbar.', true);
  }
  $('recover-btn').disabled = false;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (btn.disabled) return;
  const password = $('pw').value;
  if (!password) return;

  btn.disabled = true;
  msg('Prüfe …');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok) { location.replace('/'); return; }
    if (res.status === 429 && data?.retryAfterMs) return lockOut(data.retryAfterMs);
    if (data?.retryAfterMs) return lockOut(data.retryAfterMs);
    if (res.status === 400 && data?.error === 'login_disabled') { location.replace('/'); return; }
    msg('Falsches Passwort.', true);
    $('pw').select();
  } catch {
    msg('Server nicht erreichbar.', true);
  } finally {
    if (!lockTimer) btn.disabled = false;
  }
});

check();
