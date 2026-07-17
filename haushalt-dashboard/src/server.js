const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'haushalt.db');

// ---- Namen der beiden Personen (hier anpassen) ----
const PERSON_A = process.env.PERSON_A || 'Philipp';
const PERSON_B = process.env.PERSON_B || 'Vanessa';

// ---- Add-on-Konfiguration (von Home Assistant unter /data/options.json bereitgestellt) ----
const fs = require('fs');
let OPTIONS = {};
try {
  OPTIONS = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (e) {
  OPTIONS = {};
}
const PERSON_A_IP = (OPTIONS.person_a_ip || process.env.PERSON_A_IP || '').trim();
const PERSON_B_IP = (OPTIONS.person_b_ip || process.env.PERSON_B_IP || '').trim();

// IPv4-mapped IPv6-Adressen (z.B. "::ffff:192.168.178.50") und Localhost normalisieren
function normalizeIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('daily','weekly')),
  weekday INTEGER,          -- 0=So..6=Sa, nur bei weekly relevant; NULL = jeden Tag / egal welcher Tag der Woche
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  period_key TEXT NOT NULL,   -- z.B. '2026-07-17' fuer daily, '2026-W29' fuer weekly
  done_by TEXT NOT NULL,
  done_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  UNIQUE(task_id, period_key)
);

CREATE TABLE IF NOT EXISTS tally (
  person TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);
`);

// Tally-Zeilen sicherstellen
const ensureTally = db.prepare(`INSERT OR IGNORE INTO tally (person, count) VALUES (?, 0)`);
ensureTally.run(PERSON_A);
ensureTally.run(PERSON_B);

// Default-Aufgaben nur beim allerersten Start einfuegen
const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
if (taskCount === 0) {
  const insert = db.prepare(`INSERT INTO tasks (title, type, weekday, sort_order) VALUES (?, ?, ?, ?)`);
  const defaults = [
    // Taegliche Aufgaben
    ['Küche aufräumen', 'daily', null, 1],
    ['Spülmaschine ein-/ausräumen', 'daily', null, 2],
    ['Müll checken / rausbringen', 'daily', null, 3],
    ['Kind fertig machen (morgens)', 'daily', null, 4],
    // Woechentliche Aufgaben, grob auf Wochentage verteilt
    ['Staubsaugen', 'weekly', 1, 10],       // Montag
    ['Bad putzen', 'weekly', 2, 11],        // Dienstag
    ['Wäsche waschen', 'weekly', 3, 12],    // Mittwoch
    ['Wäsche zusammenlegen', 'weekly', 3, 13],
    ['Einkaufen (Wocheneinkauf)', 'weekly', 5, 14], // Freitag
    ['Böden wischen', 'weekly', 6, 15],     // Samstag
    ['Betten frisch beziehen', 'weekly', 0, 16],    // Sonntag
    ['Pflanzen gießen', 'weekly', 0, 17],
  ];
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(...r);
  });
  insertMany(defaults);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Hilfsfunktionen fuer Perioden-Keys ----
function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ---- API: Grunddaten (Namen) ----
app.get('/api/config', (req, res) => {
  res.json({ personA: PERSON_A, personB: PERSON_B });
});

// ---- API: Person anhand der IP-Adresse erkennen ----
app.get('/api/whoami', (req, res) => {
  const clientIp = normalizeIp(req.socket.remoteAddress);
  let person = null;
  if (PERSON_A_IP && clientIp === PERSON_A_IP) person = PERSON_A;
  else if (PERSON_B_IP && clientIp === PERSON_B_IP) person = PERSON_B;
  res.json({ person, ip: clientIp });
});

// ---- API: Alle Aufgaben inkl. heutigem/aktuellem Erledigt-Status ----
app.get('/api/tasks', (req, res) => {
  const dKey = todayKey();
  const wKey = isoWeekKey();
  const weekday = new Date().getDay(); // 0=So..6=Sa

  const tasks = db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY type, sort_order').all();
  const compStmt = db.prepare('SELECT * FROM completions WHERE task_id = ? AND period_key = ?');

  const result = tasks.map(t => {
    const periodKey = t.type === 'daily' ? dKey : wKey;
    const comp = compStmt.get(t.id, periodKey);
    return {
      id: t.id,
      title: t.title,
      type: t.type,
      weekday: t.weekday,
      isTodayFocus: t.type === 'weekly' ? t.weekday === weekday : true,
      periodKey,
      done: !!comp,
      doneBy: comp ? comp.done_by : null,
      doneAt: comp ? comp.done_at : null
    };
  });

  res.json({ tasks: result, today: dKey, week: wKey, weekday });
});

// ---- API: Aufgabe abhaken / entabhaken ----
app.post('/api/tasks/:id/toggle', (req, res) => {
  const { person } = req.body;
  if (![PERSON_A, PERSON_B].includes(person)) {
    return res.status(400).json({ error: 'Ungültige Person' });
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Aufgabe nicht gefunden' });

  const periodKey = task.type === 'daily' ? todayKey() : isoWeekKey();
  const existing = db.prepare('SELECT * FROM completions WHERE task_id = ? AND period_key = ?').get(task.id, periodKey);

  if (existing) {
    // Entabhaken -> Zaehler der Person, die es abgehakt hatte, wieder runter
    db.prepare('DELETE FROM completions WHERE id = ?').run(existing.id);
    db.prepare('UPDATE tally SET count = MAX(0, count - 1) WHERE person = ?').run(existing.done_by);
  } else {
    db.prepare(`INSERT INTO completions (task_id, period_key, done_by, done_at) VALUES (?, ?, ?, ?)`)
      .run(task.id, periodKey, person, new Date().toISOString());
    db.prepare('UPDATE tally SET count = count + 1 WHERE person = ?').run(person);
  }

  res.json({ ok: true });
});

// ---- API: Zaehlerstand ----
app.get('/api/tally', (req, res) => {
  const rows = db.prepare('SELECT * FROM tally').all();
  res.json(rows);
});

// ---- API: Zaehler zuruecksetzen (z.B. Monatsanfang) ----
app.post('/api/tally/reset', (req, res) => {
  db.prepare('UPDATE tally SET count = 0').run();
  res.json({ ok: true });
});

// ---- API: neue Aufgabe hinzufuegen ----
app.post('/api/tasks', (req, res) => {
  const { title, type, weekday } = req.body;
  if (!title || !['daily', 'weekly'].includes(type)) {
    return res.status(400).json({ error: 'Titel und gültiger Typ erforderlich' });
  }
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM tasks').get().m || 0;
  const info = db.prepare('INSERT INTO tasks (title, type, weekday, sort_order) VALUES (?, ?, ?, ?)')
    .run(title, type, type === 'weekly' ? (weekday ?? null) : null, maxOrder + 1);
  res.json({ id: info.lastInsertRowid });
});

// ---- API: Aufgabe loeschen (deaktivieren) ----
app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Haushalt-Dashboard läuft auf Port ${PORT}`);
});
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'haushalt.db');

// ---- Namen der beiden Personen (hier anpassen) ----
const PERSON_A = process.env.PERSON_A || 'Philipp';
const PERSON_B = process.env.PERSON_B || 'Vanessa';

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('daily','weekly')),
  weekday INTEGER,          -- 0=So..6=Sa, nur bei weekly relevant; NULL = jeden Tag / egal welcher Tag der Woche
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  period_key TEXT NOT NULL,   -- z.B. '2026-07-17' fuer daily, '2026-W29' fuer weekly
  done_by TEXT NOT NULL,
  done_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  UNIQUE(task_id, period_key)
);

CREATE TABLE IF NOT EXISTS tally (
  person TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);
`);

// Tally-Zeilen sicherstellen
const ensureTally = db.prepare(`INSERT OR IGNORE INTO tally (person, count) VALUES (?, 0)`);
ensureTally.run(PERSON_A);
ensureTally.run(PERSON_B);

// Default-Aufgaben nur beim allerersten Start einfuegen
const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
if (taskCount === 0) {
  const insert = db.prepare(`INSERT INTO tasks (title, type, weekday, sort_order) VALUES (?, ?, ?, ?)`);
  const defaults = [
    // Taegliche Aufgaben
    ['Küche aufräumen', 'daily', null, 1],
    ['Spülmaschine ein-/ausräumen', 'daily', null, 2],
    ['Müll checken / rausbringen', 'daily', null, 3],
    ['Kind fertig machen (morgens)', 'daily', null, 4],
    // Woechentliche Aufgaben, grob auf Wochentage verteilt
    ['Staubsaugen', 'weekly', 1, 10],       // Montag
    ['Bad putzen', 'weekly', 2, 11],        // Dienstag
    ['Wäsche waschen', 'weekly', 3, 12],    // Mittwoch
    ['Wäsche zusammenlegen', 'weekly', 3, 13],
    ['Einkaufen (Wocheneinkauf)', 'weekly', 5, 14], // Freitag
    ['Böden wischen', 'weekly', 6, 15],     // Samstag
    ['Betten frisch beziehen', 'weekly', 0, 16],    // Sonntag
    ['Pflanzen gießen', 'weekly', 0, 17],
  ];
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(...r);
  });
  insertMany(defaults);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Hilfsfunktionen fuer Perioden-Keys ----
function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ---- API: Grunddaten (Namen) ----
app.get('/api/config', (req, res) => {
  res.json({ personA: PERSON_A, personB: PERSON_B });
});

// ---- API: Alle Aufgaben inkl. heutigem/aktuellem Erledigt-Status ----
app.get('/api/tasks', (req, res) => {
  const dKey = todayKey();
  const wKey = isoWeekKey();
  const weekday = new Date().getDay(); // 0=So..6=Sa

  const tasks = db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY type, sort_order').all();
  const compStmt = db.prepare('SELECT * FROM completions WHERE task_id = ? AND period_key = ?');

  const result = tasks.map(t => {
    const periodKey = t.type === 'daily' ? dKey : wKey;
    const comp = compStmt.get(t.id, periodKey);
    return {
      id: t.id,
      title: t.title,
      type: t.type,
      weekday: t.weekday,
      isTodayFocus: t.type === 'weekly' ? t.weekday === weekday : true,
      periodKey,
      done: !!comp,
      doneBy: comp ? comp.done_by : null,
      doneAt: comp ? comp.done_at : null
    };
  });

  res.json({ tasks: result, today: dKey, week: wKey, weekday });
});

// ---- API: Aufgabe abhaken / entabhaken ----
app.post('/api/tasks/:id/toggle', (req, res) => {
  const { person } = req.body;
  if (![PERSON_A, PERSON_B].includes(person)) {
    return res.status(400).json({ error: 'Ungültige Person' });
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Aufgabe nicht gefunden' });

  const periodKey = task.type === 'daily' ? todayKey() : isoWeekKey();
  const existing = db.prepare('SELECT * FROM completions WHERE task_id = ? AND period_key = ?').get(task.id, periodKey);

  if (existing) {
    // Entabhaken -> Zaehler der Person, die es abgehakt hatte, wieder runter
    db.prepare('DELETE FROM completions WHERE id = ?').run(existing.id);
    db.prepare('UPDATE tally SET count = MAX(0, count - 1) WHERE person = ?').run(existing.done_by);
  } else {
    db.prepare(`INSERT INTO completions (task_id, period_key, done_by, done_at) VALUES (?, ?, ?, ?)`)
      .run(task.id, periodKey, person, new Date().toISOString());
    db.prepare('UPDATE tally SET count = count + 1 WHERE person = ?').run(person);
  }

  res.json({ ok: true });
});

// ---- API: Zaehlerstand ----
app.get('/api/tally', (req, res) => {
  const rows = db.prepare('SELECT * FROM tally').all();
  res.json(rows);
});

// ---- API: Zaehler zuruecksetzen (z.B. Monatsanfang) ----
app.post('/api/tally/reset', (req, res) => {
  db.prepare('UPDATE tally SET count = 0').run();
  res.json({ ok: true });
});

// ---- API: neue Aufgabe hinzufuegen ----
app.post('/api/tasks', (req, res) => {
  const { title, type, weekday } = req.body;
  if (!title || !['daily', 'weekly'].includes(type)) {
    return res.status(400).json({ error: 'Titel und gültiger Typ erforderlich' });
  }
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM tasks').get().m || 0;
  const info = db.prepare('INSERT INTO tasks (title, type, weekday, sort_order) VALUES (?, ?, ?, ?)')
    .run(title, type, type === 'weekly' ? (weekday ?? null) : null, maxOrder + 1);
  res.json({ id: info.lastInsertRowid });
});

// ---- API: Aufgabe loeschen (deaktivieren) ----
app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Haushalt-Dashboard läuft auf Port ${PORT}`);
});
