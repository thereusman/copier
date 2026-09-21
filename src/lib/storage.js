const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'phase1.json');

const defaults = () => ({
  settings: {
    simulationMode: process.env.SIMULATION_MODE !== 'false',
    accountBalance: 10000,
    riskPercent: 1,
    maxLots: 0.1,
    maxDailyLoss: 300,
    allowedSymbols: ['XAUUSD', 'EURUSD', 'GBPUSD'],
    executionEnabled: true,
    executionTarget: 'SIMULATED',
    mt5AgentId: null
  },
  signals: [],
  trades: [],
  audit: [],
  agents: [],
  connections: [{
    id: 'conn_xbtfx_demo', provider: 'XBTFX', label: 'XBTFX Direct API',
    mode: 'DEMO', status: 'NOT_CONFIGURED', createdAt: new Date().toISOString()
  }]
});

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaults(), null, 2));
    return;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const original = JSON.parse(raw);
  const upgraded = normalise(original);
  if (JSON.stringify(original) !== JSON.stringify(upgraded)) fs.writeFileSync(DB_PATH, JSON.stringify(upgraded, null, 2));
}

function normalise(db) {
  db.settings = { ...defaults().settings, ...(db.settings || {}) };
  db.connections = db.connections || [];
  db.extensions = db.extensions || [];
  db.discordSources = db.discordSources || [];
  db.extensionPairingCode = db.extensionPairingCode || crypto.randomBytes(4).toString('hex').toUpperCase();
  return db;
}

function read() { ensure(); return normalise(JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))); }
function write(db) { ensure(); fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); return db; }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

function mutate(fn) {
  const db = read();
  const value = fn(db);
  write(db);
  return value;
}

function audit(db, event, detail) {
  db.audit.unshift({ id: id('audit'), at: new Date().toISOString(), event, detail });
  db.audit = db.audit.slice(0, 500);
}

module.exports = { read, mutate, audit, id };
