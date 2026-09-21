const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { read, mutate, audit, id } = require('./lib/storage');
const { parseSignal } = require('./lib/parser');
const { assess } = require('./lib/risk');
const { xbtfxConfiguration, queueDemoOrder } = require('./lib/xbtfx');
const { attachLiveServer } = require('./lib/live');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(process.cwd(), 'public');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function allowExtensionOrigin(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin.startsWith('chrome-extension://')) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  return true;
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function pairingCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

function extensionFor(db, req) {
  const token = bearer(req);
  return db.extensions.find((item) => item.token === token && !item.revokedAt) || null;
}

function agentStatus(agent) {
  if (!agent.lastSeenAt) return 'WAITING_FOR_AGENT';
  const lastSeen = new Date(agent.lastSeenAt).getTime();
  return Number.isFinite(lastSeen) && Date.now() - lastSeen < 45000 ? 'ONLINE' : 'OFFLINE';
}

function publicAgent(agent) {
  const { token, ...safe } = agent;
  return { ...safe, status: agentStatus(agent) };
}

function agentFor(db, req, agentId) {
  const token = bearer(req);
  return db.agents.find((item) => item.id === agentId && item.token === token) || null;
}

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100000) throw new Error('Request body is too large.');
  }
  return data ? JSON.parse(data) : {};
}

function summary(db) {
  return {
    settings: db.settings,
    trades: db.trades.slice(0, 20),
    signals: db.signals.slice(0, 20),
    audit: db.audit.slice(0, 30),
    agents: db.agents.map(publicAgent),
    connections: db.connections || [],
    discordSources: db.discordSources || [],
    extensionPairingCode: db.extensionPairingCode,
    xbtfx: xbtfxConfiguration(),
    counts: {
      signals: db.signals.length,
      approved: db.signals.filter((signal) => signal.decision === 'APPROVED').length,
      rejected: db.signals.filter((signal) => signal.decision === 'REJECTED').length,
      open: db.trades.filter((trade) => trade.status === 'OPEN').length
    }
  };
}

function handleSignal(payload) {
  const raw = String(payload.message || '');
  if (!raw.trim()) return { status: 400, body: { error: 'message is required' } };
  const externalId = String(payload.externalId || '').trim().slice(0, 220);
  const incomingSource = String(payload.source || 'manual');
  const incomingChannel = String(payload.channel || 'unassigned');
  const duplicateCutoff = Date.now() - (2 * 60 * 1000);
  const existing = read().signals.find((signal) => {
    if (externalId && signal.externalId === externalId) return true;
    return !externalId && signal.source === incomingSource && signal.channel === incomingChannel && signal.raw === raw && new Date(signal.receivedAt).getTime() >= duplicateCutoff;
  });
  if (existing) return { status: 200, body: { ...existing, duplicate: true } };
  if (payload.observedOnly) {
    const observed = mutate((db) => {
      const signal = {
        id: id('sig'), receivedAt: new Date().toISOString(), source: incomingSource, channel: incomingChannel,
        sourceId: String(payload.sourceId || '').trim() || null, externalId: externalId || null,
        sourceMode: 'OBSERVE', raw, parsed: { ok: false, observed: true }, lifecycle: 'OBSERVED',
        decision: 'OBSERVED', decisionReason: 'Observer mode: message captured without parser or trade workflow.', tradeId: null
      };
      db.signals.unshift(signal); audit(db, 'DISCORD_MESSAGE_OBSERVED', { signalId: signal.id, sourceId: signal.sourceId });
      return signal;
    });
    return { status: 201, body: observed };
  }
  const parsed = parseSignal(raw);
  const result = mutate((db) => {
    const signal = {
      id: id('sig'), receivedAt: new Date().toISOString(), source: incomingSource,
      channel: incomingChannel, sourceId: String(payload.sourceId || '').trim() || null,
      externalId: externalId || null, sourceMode: String(payload.sourceMode || 'PAPER'), raw, parsed,
      lifecycle: parsed.kind || 'UNPARSED', decision: 'REJECTED', decisionReason: '', tradeId: null
    };
    if (!parsed.ok) {
      signal.decisionReason = parsed.reason;
      db.signals.unshift(signal); audit(db, 'SIGNAL_REJECTED', { signalId: signal.id, reason: parsed.reason });
      return signal;
    }
    if (parsed.kind !== 'ENTRY') {
      const target = db.trades.find((trade) => trade.status === 'OPEN' && trade.symbol === parsed.symbol && trade.source === signal.source && trade.channel === signal.channel);
      if (!target) {
        signal.decisionReason = `No open ${parsed.symbol} trade exists for this source and channel.`;
        db.signals.unshift(signal); audit(db, 'LIFECYCLE_UPDATE_REJECTED', { signalId: signal.id, kind: parsed.kind, reason: signal.decisionReason });
        return signal;
      }
      signal.decision = 'APPROVED'; signal.tradeId = target.id;
      if (parsed.kind === 'UPDATE_STOP') { target.stopLoss = parsed.stopLoss; target.lastUpdateAt = signal.receivedAt; target.execution = 'SIMULATED_STOP_UPDATED'; signal.decisionReason = `Stop loss updated on ${target.id}.`; }
      if (parsed.kind === 'UPDATE_TARGET') { target.takeProfit = parsed.takeProfit; target.lastUpdateAt = signal.receivedAt; target.execution = 'SIMULATED_TARGET_UPDATED'; signal.decisionReason = `Take profit updated on ${target.id}.`; }
      if (parsed.kind === 'CLOSE') { target.status = 'CLOSED'; target.closedAt = signal.receivedAt; target.execution = 'SIMULATED_CLOSE'; target.agentJobState = 'COMPLETE'; signal.decisionReason = `Trade ${target.id} marked closed in simulation.`; }
      audit(db, `LIFECYCLE_${parsed.kind}_APPLIED`, { signalId: signal.id, tradeId: target.id, symbol: target.symbol });
      db.signals.unshift(signal);
      return signal;
    }
    const decision = assess({ trade: parsed.trade, settings: db.settings, trades: db.trades });
    signal.decision = decision.approved ? 'APPROVED' : 'REJECTED';
    signal.decisionReason = decision.reason;
    if (decision.approved) {
      const executionTarget = signal.sourceMode === 'PAPER' || db.settings.simulationMode ? 'SIMULATED' : db.settings.executionTarget;
      const trade = {
        id: id('trade'), signalId: signal.id, createdAt: new Date().toISOString(), status: 'OPEN',
        source: signal.source, channel: signal.channel, sourceMode: signal.sourceMode, ...parsed.trade, lots: decision.lots, pnl: 0,
        execution: executionTarget === 'SIMULATED' ? 'SIMULATED' : executionTarget === 'XBTFX' ? 'QUEUED_XBTFX_DEMO' : 'PENDING_AGENT',
        agentId: executionTarget === 'MT5_AGENT' ? db.settings.mt5AgentId || null : null,
        agentJobState: executionTarget === 'SIMULATED' ? 'COMPLETE' : 'QUEUED'
      };
      if (executionTarget === 'MT5_AGENT' && !trade.agentId) {
        trade.execution = 'BLOCKED_NO_MT5_AGENT';
        trade.agentJobState = 'BLOCKED';
        signal.decisionReason = 'Approved in Paper workflow, but no MT5 agent is selected.';
      }
      if (executionTarget === 'XBTFX') trade.brokerJob = queueDemoOrder(trade);
      signal.tradeId = trade.id; db.trades.unshift(trade);
      const event = executionTarget === 'SIMULATED' ? 'SIMULATED_ORDER_OPENED' : executionTarget === 'XBTFX' ? 'XBTFX_DEMO_ORDER_QUEUED' : 'ORDER_QUEUED_FOR_AGENT';
      audit(db, event, { signalId: signal.id, tradeId: trade.id, lots: trade.lots });
    } else audit(db, 'SIGNAL_REJECTED', { signalId: signal.id, reason: decision.reason });
    db.signals.unshift(signal);
    return signal;
  });
  return { status: 201, body: result };
}

function serveAsset(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url;
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res); return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS' && allowExtensionOrigin(req, res)) return res.end();
    allowExtensionOrigin(req, res);
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/app') { req.url = '/app.html'; return serveAsset(req, res); }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, summary(read()));
    if (req.method === 'POST' && url.pathname === '/api/signals') {
      const result = handleSignal(await body(req));
      if (result.status === 201) live.broadcast('signal.created', { signal: result.body });
      return json(res, result.status, result.body);
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const incoming = await body(req);
      const updated = mutate((db) => {
        const next = { ...db.settings, ...incoming };
        next.accountBalance = Math.max(0, Number(next.accountBalance));
        next.riskPercent = Math.min(10, Math.max(0.01, Number(next.riskPercent)));
        next.maxLots = Math.min(100, Math.max(0.01, Number(next.maxLots)));
        next.maxDailyLoss = Math.max(0, Number(next.maxDailyLoss));
        next.executionTarget = ['SIMULATED', 'XBTFX', 'MT5_AGENT'].includes(next.executionTarget) ? next.executionTarget : 'SIMULATED';
        next.mt5AgentId = db.agents.some((agent) => agent.id === next.mt5AgentId) ? next.mt5AgentId : null;
        // Any direct broker route remains demo-only until a later explicit live-release workflow.
        if (next.executionTarget === 'XBTFX') next.simulationMode = false;
        next.allowedSymbols = Array.isArray(next.allowedSymbols) ? next.allowedSymbols.map((value) => String(value).trim().toUpperCase()).filter(Boolean) : db.settings.allowedSymbols;
        db.settings = next; audit(db, 'SETTINGS_UPDATED', { simulationMode: next.simulationMode, executionEnabled: next.executionEnabled }); return next;
      });
      return json(res, 200, updated);
    }
    if (req.method === 'POST' && url.pathname === '/api/connections/xbtfx/prepare-demo') {
      const connection = mutate((db) => {
        db.connections = db.connections || [];
        let target = db.connections.find((item) => item.provider === 'XBTFX');
        if (!target) {
          target = { id: id('conn'), provider: 'XBTFX', label: 'XBTFX Direct API', mode: 'DEMO', createdAt: new Date().toISOString() };
          db.connections.push(target);
        }
        target.status = 'DEMO_READY'; target.preparedAt = new Date().toISOString();
        audit(db, 'XBTFX_DEMO_CONNECTOR_PREPARED', { connectionId: target.id });
        return target;
      });
      return json(res, 200, { connection, xbtfx: xbtfxConfiguration(), message: 'XBTFX demo connector prepared. No credentials or network requests were used.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/extension/pair') {
      const incoming = await body(req);
      const paired = mutate((db) => {
        if (String(incoming.pairingCode || '').trim().toUpperCase() !== db.extensionPairingCode) return null;
        const extension = { id: id('ext'), name: 'Discord Channel Connector', token: id('ext_token'), pairedAt: new Date().toISOString(), lastSeenAt: null };
        db.extensions.push(extension); db.extensionPairingCode = pairingCode();
        audit(db, 'DISCORD_EXTENSION_PAIRED', { extensionId: extension.id });
        return extension;
      });
      if (!paired) return json(res, 401, { error: 'Invalid pairing code.' });
      return json(res, 201, { extensionId: paired.id, token: paired.token, serverUrl: `http://localhost:${PORT}` });
    }
    if (req.method === 'GET' && url.pathname === '/api/extension/discord-sources') {
      const db = read(); const extension = extensionFor(db, req);
      if (!extension) return json(res, 401, { error: 'Pair this extension before loading sources.' });
      return json(res, 200, { sources: db.discordSources || [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/extension/discord-sources') {
      const incoming = await body(req); const db = read(); const extension = extensionFor(db, req);
      if (!extension) return json(res, 401, { error: 'Pair this extension before saving sources.' });
      const submitted = Array.isArray(incoming.sources) ? incoming.sources.slice(0, 100) : [];
      const sources = submitted.map((source) => ({
        serverId: String(source.serverId || '').trim(), channelId: String(source.channelId || '').trim(),
        serverName: String(source.serverName || 'Discord server').trim().slice(0, 100),
        channelName: String(source.channelName || 'channel').trim().slice(0, 100),
        mode: source.mode === 'LIVE' ? 'LIVE' : 'PAPER'
      })).filter((source) => /^\d{5,}$/.test(source.serverId) && /^\d{5,}$/.test(source.channelId));
      const saved = mutate((state) => {
        const current = state.extensions.find((item) => item.id === extension.id); current.lastSeenAt = new Date().toISOString();
        state.discordSources = sources.map((source) => {
          const prior = (state.discordSources || []).find((item) => item.serverId === source.serverId && item.channelId === source.channelId);
          return {
            id: prior?.id || id('src'), provider: 'DISCORD_EXTENSION', enabled: prior?.enabled ?? true,
            riskMultiplier: prior?.riskMultiplier || 1, captureMode: prior?.captureMode === 'OBSERVE' ? 'OBSERVE' : 'SIGNALS',
            ...source, updatedAt: new Date().toISOString()
          };
        });
        audit(state, 'DISCORD_SOURCES_UPDATED', { extensionId: extension.id, count: state.discordSources.length });
        return state.discordSources;
      });
      live.broadcast('sources.updated', { sources: saved });
      return json(res, 200, { sources: saved });
    }
    const sourceUpdateMatch = url.pathname.match(/^\/api\/discord-sources\/([^/]+)$/);
    if (req.method === 'PATCH' && sourceUpdateMatch) {
      const incoming = await body(req);
      const updated = mutate((db) => {
        const source = (db.discordSources || []).find((item) => item.id === sourceUpdateMatch[1]);
        if (!source) return null;
        if (typeof incoming.enabled === 'boolean') source.enabled = incoming.enabled;
        if (['SIGNALS', 'OBSERVE'].includes(incoming.captureMode)) source.captureMode = incoming.captureMode;
        source.updatedAt = new Date().toISOString();
        const event = incoming.captureMode ? `DISCORD_SOURCE_${source.captureMode}` : source.enabled ? 'DISCORD_SOURCE_RESUMED' : 'DISCORD_SOURCE_PAUSED';
        audit(db, event, { sourceId: source.id, channelId: source.channelId });
        return source;
      });
      if (updated) live.broadcast('sources.updated', { source: updated });
      return updated ? json(res, 200, { source: updated }) : json(res, 404, { error: 'Unknown Discord source.' });
    }
    if (req.method === 'DELETE' && sourceUpdateMatch) {
      const removed = mutate((db) => {
        const sources = db.discordSources || [];
        const source = sources.find((item) => item.id === sourceUpdateMatch[1]);
        if (!source) return null;
        db.discordSources = sources.filter((item) => item.id !== source.id);
        audit(db, 'DISCORD_SOURCE_REMOVED', { sourceId: source.id, channelId: source.channelId });
        return source;
      });
      if (removed) live.broadcast('sources.updated', { removedSourceId: removed.id });
      return removed ? json(res, 200, { removed }) : json(res, 404, { error: 'Unknown Discord source.' });
    }
    const signalSourceMatch = url.pathname.match(/^\/api\/signals\/source\/([^/]+)$/);
    if (req.method === 'DELETE' && signalSourceMatch) {
      const removed = mutate((db) => {
        const sourceId = decodeURIComponent(signalSourceMatch[1]);
        const count = db.signals.filter((signal) => signal.sourceId === sourceId).length;
        db.signals = db.signals.filter((signal) => signal.sourceId !== sourceId);
        audit(db, 'SIGNAL_HISTORY_CLEARED_FOR_SOURCE', { sourceId, count });
        return { sourceId, count };
      });
      live.broadcast('signal.history.cleared', removed);
      return json(res, 200, { removed });
    }
    if (req.method === 'POST' && url.pathname === '/api/extension/discord-message') {
      const incoming = await body(req); const db = read(); const extension = extensionFor(db, req);
      if (!extension) return json(res, 401, { error: 'Pair this extension before sending messages.' });
      const source = (db.discordSources || []).find((item) => item.enabled && item.serverId === String(incoming.serverId) && item.channelId === String(incoming.channelId));
      if (!source) return json(res, 403, { error: 'This Discord channel is not selected.' });
      const messageId = String(incoming.messageId || '').trim();
      const result = handleSignal({
        source: `discord:${source.serverName}`, channel: `#${source.channelName}`, sourceId: source.id,
        sourceMode: source.mode || 'PAPER', observedOnly: Boolean(incoming.observedOnly) && source.captureMode === 'OBSERVE',
        externalId: messageId ? `discord:${extension.id}:${messageId}` : null,
        message: incoming.message
      });
      if (result.status === 201) live.broadcast('signal.created', { signal: result.body });
      return json(res, result.status, result.body);
    }
    if (req.method === 'POST' && url.pathname === '/api/replay') {
      const incoming = await body(req);
      const messages = Array.isArray(incoming.messages) ? incoming.messages.slice(0, 30) : [];
      const preview = messages.map((message) => {
        const parsed = parseSignal(String(message || ''));
        return parsed.ok ? { raw: String(message), kind: parsed.kind, parsed, outcome: 'WOULD_ENTER_PAPER_WORKFLOW' } : { raw: String(message), parsed, outcome: 'NEEDS_REVIEW' };
      });
      return json(res, 200, { count: preview.length, preview, note: 'Replay never creates trades or sends an execution request.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/agents') {
      const incoming = await body(req);
      const registered = mutate((db) => {
        const agent = { id: id('agent'), name: String(incoming.name || 'Windows MT5 Agent').trim().slice(0, 80), token: id('token'), createdAt: new Date().toISOString(), lastSeenAt: null };
        db.agents.push(agent); audit(db, 'AGENT_REGISTERED', { agentId: agent.id, name: agent.name }); return agent;
      });
      return json(res, 201, { agent: publicAgent(registered), enrollment: { agentId: registered.id, token: registered.token, serverUrl: `http://localhost:${PORT}`, transport: 'OUTBOUND_POLL_ONLY', note: 'Shown once for local installation. Store it in the MT5 agent configuration, never in a browser form.' } });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
      const incoming = await body(req);
      const agentId = String(req.headers['x-sacred-soul-agent'] || '');
      const db = read(); const agent = agentFor(db, req, agentId);
      if (!agent) return json(res, 401, { error: 'Invalid agent credentials.' });
      const updated = mutate((state) => {
        const current = state.agents.find((item) => item.id === agent.id);
        current.lastSeenAt = new Date().toISOString();
        current.lastHeartbeat = {
          terminal: String(incoming.terminal || 'MetaTrader 5').slice(0, 100),
          connected: Boolean(incoming.connected),
          accountNumber: String(incoming.accountNumber || '').slice(0, 32) || null,
          at: current.lastSeenAt
        };
        audit(state, 'AGENT_HEARTBEAT', { agentId: current.id, connected: current.lastHeartbeat.connected });
        return current;
      });
      return json(res, 200, { agent: publicAgent(updated), executionMode: 'PAPER_ONLY' });
    }
    if (req.method === 'GET' && url.pathname === '/api/agent/jobs') {
      const agentId = String(req.headers['x-sacred-soul-agent'] || '');
      const db = read(); const agent = agentFor(db, req, agentId);
      if (!agent) return json(res, 401, { error: 'Invalid agent credentials.' });
      const jobs = db.trades.filter((trade) => trade.agentJobState === 'QUEUED' && trade.agentId === agent.id).slice(0, 5);
      mutate((state) => { const current = state.agents.find((item) => item.id === agentId); current.lastSeenAt = new Date().toISOString(); audit(state, 'AGENT_POLLED', { agentId, jobs: jobs.length }); });
      return json(res, 200, { agent: publicAgent({ ...agent, lastSeenAt: new Date().toISOString() }), jobs, executionMode: 'PAPER_ONLY' });
    }
    const match = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/result$/);
    if (req.method === 'POST' && match) {
      const incoming = await body(req);
      const trade = mutate((db) => {
        const target = db.trades.find((item) => item.id === match[1]);
        if (!target) return null;
        const agent = agentFor(db, req, target.agentId);
        if (!agent || target.agentJobState !== 'QUEUED') return null;
        target.execution = incoming.ok ? 'EXECUTED_BY_AGENT' : 'AGENT_REJECTED'; target.agentJobState = 'COMPLETE';
        target.agentResult = { at: new Date().toISOString(), ok: Boolean(incoming.ok), ticket: incoming.ticket || null, reason: incoming.reason || null };
        if (!incoming.ok) target.status = 'REJECTED'; audit(db, 'AGENT_RESULT_RECEIVED', { tradeId: target.id, ok: Boolean(incoming.ok) }); return target;
      });
      return trade ? json(res, 200, trade) : json(res, 404, { error: 'Unknown trade.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      const cleared = mutate((db) => { db.signals = []; db.trades = []; db.audit = []; audit(db, 'DEMO_DATA_RESET', {}); return summary(db); });
      return json(res, 200, cleared);
    }
    if (req.method === 'GET' && serveAsset(req, res)) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 400, { error: error.message || 'Request could not be processed.' }); }
});

const live = attachLiveServer(server);

server.listen(PORT, () => console.log(`Signal Pilot Phase 1 is running at http://localhost:${PORT}`));
