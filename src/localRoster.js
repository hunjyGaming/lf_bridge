'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Optional self-maintained name list. Replaces the online roster that was
 * removed. It is a CSV file YOU keep, one row per player:
 *
 *   id,name,team
 *   1234,Mara,Rot
 *   5678,Jonas,Rot
 *   @91,Guest 1,
 *
 * - `id` matches the Laserforce id from a type-3 login line, with or without a
 *   leading @ / # (both are stripped for matching).
 * - `name` overrides the name from the stream.
 * - `team` (optional) overrides the team name for that player's team, using the
 *   engine's existing "most common DB team name wins" logic.
 *
 * Header row optional. `;` or `,` as separator, both accepted.
 */
class LocalRoster {
  constructor({ logger, getConfig }) {
    this.log = logger;
    this.getConfig = getConfig;
    this.map = {};
    this.lastLoad = null;
    this.lastError = null;
  }

  status() {
    const c = this.getConfig().localRoster;
    return { enabled: c.enabled, file: c.file, players: Object.keys(this.map).length, lastLoad: this.lastLoad, lastError: this.lastError };
  }

  load() {
    const c = this.getConfig().localRoster;
    if (!c.enabled) { this.map = {}; return this.map; }
    const file = path.resolve(process.cwd(), c.file);
    try {
      const text = fs.readFileSync(file, 'utf8');
      this.map = parse(text);
      this.lastLoad = Date.now();
      this.lastError = null;
      this.log.info('roster', `local roster: ${Object.keys(this.map).length} players from ${c.file}`);
    } catch (err) {
      this.map = {};
      this.lastError = err.code === 'ENOENT' ? `Datei nicht gefunden: ${c.file}` : err.message;
      this.log.warn('roster', `local roster: ${this.lastError}`);
    }
    return this.map;
  }

  getMap() { return this.map; }
}

function parse(text) {
  const clean = text.replace(/^﻿/, '');
  const map = {};
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(/[;,]/).map((s) => s.trim());
    if (/^id$/i.test(cells[0])) continue; // header
    const id = String(cells[0] || '').replace(/[@#]/g, '').trim();
    if (!id) continue;
    map[id] = { nick: cells[1] || id, dbTeamName: cells[2] || null, avatar: null };
  }
  return map;
}

module.exports = { LocalRoster };
