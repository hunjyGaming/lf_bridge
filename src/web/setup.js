'use strict';

// Erste Einrichtung: das allererste Admin-Passwort im Browser vergeben.
// Nur erreichbar, solange keines gesetzt ist — danach schickt der Server
// hierher kommende Anfragen auf /login.

const $ = (id) => document.getElementById(id);
const form = $('setup-form');
const btn = $('setup-btn');
const msgEl = $('setup-msg');

function msg(text, bad) {
  msgEl.textContent = text;
  msgEl.classList.toggle('bad', !!bad);
  msgEl.hidden = !text;
}

async function check() {
  try {
    const info = (await (await fetch('/api/auth/session')).json())?.data;
    if (info && !info.setupPending) location.replace(info.authenticated ? '/' : '/login');
  } catch { /* Server noch nicht bereit — das Formular funktioniert trotzdem */ }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('pw1').value;
  const pw2 = $('pw2').value;
  if (pw.length < 8) return msg('Mindestens 8 Zeichen.', true);
  if (pw !== pw2) { msg('Die beiden Eingaben stimmen nicht überein.', true); $('pw2').select(); return; }

  btn.disabled = true;
  msg('Speichere …');
  try {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' },
      body: JSON.stringify({ next: pw }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) { location.replace('/'); return; }
    if (res.status === 409) { msg('Es wurde schon eingerichtet — weiter zur Anmeldung …', true); setTimeout(() => location.replace('/login'), 1500); return; }
    msg(data?.hint || 'Konnte nicht gespeichert werden.', true);
  } catch {
    msg('Server nicht erreichbar.', true);
  }
  btn.disabled = false;
});

check();
