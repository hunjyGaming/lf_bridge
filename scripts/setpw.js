'use strict';

/**
 * Admin-Passwort der Konsole setzen oder zurücksetzen — der Weg zurück,
 * wenn niemand mehr reinkommt.
 *
 *   npm run setpw                  neues Passwort abfragen (Eingabe unsichtbar)
 *   npm run setpw -- --random      zufälliges erzeugen und anzeigen
 *   npm run setpw -- --show        nur anzeigen, ob ein Passwort gesetzt ist
 *
 * Läuft gegen dieselbe config.json wie der Dienst (Arbeitsverzeichnis beachten).
 * Ein in der .env gesetztes LF_ADMIN_PASSWORD hat Vorrang — dann meldet das
 * Skript das und ändert nichts.
 */

const readline = require('readline');
const { Config } = require('../src/config');
const { hashPasswordSync, generatePassword, passwordProblem } = require('../src/auth');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const config = new Config();
config.load();

if (has('--show')) {
  console.log(`config:    ${config.file}`);
  console.log(`Login an:  ${config.data.admin.enabled !== false ? 'ja' : 'nein (LF_ADMIN_ENABLED=false)'}`);
  console.log(`Passwort:  ${config.data.admin.passwordHash ? 'gesetzt' : 'NICHT gesetzt'}`);
  console.log(`aus .env:  ${config.isPinned('admin.passwordHash') ? 'ja — LF_ADMIN_PASSWORD/_HASH' : 'nein'}`);
  process.exit(0);
}

if (config.isPinned('admin.passwordHash')) {
  console.error('Das Passwort steht in der .env (LF_ADMIN_PASSWORD bzw. LF_ADMIN_PASSWORD_HASH).');
  console.error('Bitte dort ändern und den Dienst neu starten — diese Datei hat Vorrang.');
  process.exit(2);
}

if (has('--random')) {
  const pw = generatePassword();
  store(pw);
  console.log('\nNeues Admin-Passwort:\n');
  console.log(`    ${pw}\n`);
  restartHint();
  process.exit(0);
}

(async () => {
  const pw = await ask('Neues Admin-Passwort: ');
  const problem = passwordProblem(pw);
  if (problem) { console.error(`\nAbgebrochen: ${problem}`); process.exit(1); }
  const again = await ask('Zur Bestätigung wiederholen: ');
  if (pw !== again) { console.error('\nAbgebrochen: die Eingaben stimmen nicht überein.'); process.exit(1); }
  store(pw);
  console.log('\nGespeichert.');
  restartHint();
})();

function store(pw) {
  config.data.admin.enabled = true;
  config.setAdminPasswordHash(hashPasswordSync(pw));
  console.log(`\ngeschrieben nach ${config.file}`);
}

/**
 * Der laufende Dienst hält seine Konfiguration im Speicher und liest die Datei
 * nicht neu — er würde sie beim nächsten Speichern aus der Konsole sogar wieder
 * überschreiben. Also: Dienst stoppen, hier ändern, Dienst starten.
 */
function restartHint() {
  console.log('Der Dienst muss neu gestartet werden, damit das Passwort gilt');
  console.log('(am besten: Dienst stoppen -> setpw -> Dienst starten).');
}

/** Passwortabfrage ohne Echo. Fällt auf normale Eingabe zurück, wenn kein TTY. */
function ask(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(prompt, (a) => { rl.close(); resolve(a); });
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onKeypress = (chunk) => {
      const s = String(chunk);
      if (s === '\r' || s === '\n' || s === '') return;
      readline.moveCursor(process.stdout, -1, 0);
      readline.clearLine(process.stdout, 1);
    };
    rl.question(prompt, (a) => {
      process.stdin.removeListener('data', onKeypress);
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
    process.stdin.on('data', onKeypress);
  });
}
