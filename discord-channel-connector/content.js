let selectedSources = [];
let initialMessageIds = new Set();

function route() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[0] === 'channels' && /^\d+$/.test(parts[1] || '') && /^\d+$/.test(parts[2] || '') ? { serverId: parts[1], channelId: parts[2] } : null;
}
function callApi(path, options) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime?.id) throw new Error('The extension was reloaded. Refresh Discord once, then try again.');
      chrome.runtime.sendMessage({ type: 'SIGNAL_PILOT_API', path, options }, (response) => {
        if (!chrome.runtime?.id || chrome.runtime.lastError) {
          reject(new Error('The extension was reloaded. Refresh Discord once, then try again.'));
          return;
        }
        response?.ok ? resolve(response.data) : reject(new Error(response?.error || 'Extension service unavailable.'));
      });
    } catch (error) { reject(error); }
  });
}
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char])); }
function serverName() { return document.querySelector('[aria-label$="(server)"] button')?.textContent?.replace(/, server actions$/, '').trim() || 'Discord server'; }
function discoverChannels() {
  const channels = new Map();
  document.querySelectorAll('a[href^="/channels/"]').forEach((node) => {
    const match = node.getAttribute('href').match(/^\/channels\/(\d+)\/(\d+)/); if (!match) return;
    const [, serverId, channelId] = match;
    channels.set(`${serverId}:${channelId}`, { serverId, channelId, serverName: serverName(), channelName: node.textContent.replace(/^#\s*/, '').trim().slice(0, 100) || 'channel' });
  });
  const current = route();
  if (current && !channels.has(`${current.serverId}:${current.channelId}`)) channels.set(`${current.serverId}:${current.channelId}`, { ...current, serverName: serverName(), channelName: document.querySelector('[aria-label$=" chat"]')?.textContent?.replace(/ chat$/, '') || 'current channel' });
  return [...channels.values()];
}
async function loadSources() { const { sources = [] } = await chrome.storage.local.get(['sources']); selectedSources = sources; return sources; }
async function syncSources() { const result = await callApi('/api/extension/discord-sources', { method: 'GET' }); selectedSources = result.sources || []; await chrome.storage.local.set({ sources: selectedSources }); return selectedSources; }
function mount() {
  if (document.getElementById('signal-pilot-discord-root')) return;
  const root = document.createElement('div'); root.id = 'signal-pilot-discord-root'; root.attachShadow({ mode: 'open' });
  root.shadowRoot.innerHTML = `<style>:host{all:initial}button{font:600 14px system-ui,sans-serif;cursor:pointer}.launch{position:fixed;right:28px;bottom:24px;z-index:999999;border:1px solid #45e0a6;border-radius:999px;background:#10241d;color:#eafff1;padding:12px 17px;box-shadow:0 8px 26px #0008}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#45e0a6;margin-right:7px}.backdrop{position:fixed;inset:0;z-index:1000000;background:#0009;display:grid;place-items:center}.backdrop[hidden]{display:none!important}.card{width:min(520px,calc(100vw - 32px));max-height:78vh;overflow:auto;border:1px solid #245441;border-radius:15px;background:#0b1914;color:#effbf4;padding:20px;font:14px/1.45 system-ui,sans-serif}.head{display:flex;justify-content:space-between;gap:16px}.head h2{font-size:20px;margin:4px 0}.head p,.hint{color:#95aa9f;margin:0}.eyebrow{font-size:10px;font-weight:800;letter-spacing:.12em;color:#55e6ae}.channel{display:flex;gap:10px;padding:10px 2px;border-bottom:1px solid #1b392d;align-items:center}.channel input{width:17px;height:17px}.channel b,.channel small{display:block}.channel small{font-size:11px;color:#91aa9d}.actions{display:flex;gap:10px;margin-top:16px}.primary{border:0;border-radius:8px;padding:10px 13px;background:#55e6ae;color:#052117}.secondary{border:1px solid #315a49;border-radius:8px;padding:10px 13px;background:transparent;color:#d7eee1}.error{color:#ffb3b9}.code{font-family:ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;width:100%;padding:10px;background:#06120e;border:1px solid #285340;color:#effff6;border-radius:7px;box-sizing:border-box;margin:9px 0}</style><button class="launch"><span class="dot"></span>Sacred Soul</button><div class="backdrop" hidden></div>`;
  const launch = root.shadowRoot.querySelector('.launch'); launch.innerHTML = '<span class="dot"></span>Sacred Soul';
  launch.addEventListener('click', openPanel); document.documentElement.append(root);
}
function closePanel() { document.getElementById('signal-pilot-discord-root')?.shadowRoot.querySelector('.backdrop').setAttribute('hidden', ''); }
async function openPanel() {
  const root = document.getElementById('signal-pilot-discord-root'); if (!root) return; const backdrop = root.shadowRoot.querySelector('.backdrop'); backdrop.removeAttribute('hidden');
  const saved = await chrome.storage.local.get(['token']);
  if (!saved.token) {
    backdrop.innerHTML = `<section class="card"><span class="eyebrow">CONNECT DISCORD</span><h2>Pair this browser</h2><p class="hint">This one-time code is supplied by Sacred Soul. Discord credentials are never requested here.</p><input class="code" id="pairing-code" placeholder="PAIRING CODE" maxlength="8"><div class="actions"><button class="primary" id="pair">Pair & continue</button><button class="secondary" id="cancel">Cancel</button></div><p class="error" id="error"></p></section>`;
    backdrop.querySelector('#cancel').onclick = closePanel;
    backdrop.querySelector('#pair').onclick = async () => { try { const result = await callApi('/api/extension/pair', { method: 'POST', body: JSON.stringify({ pairingCode: backdrop.querySelector('#pairing-code').value }) }); await chrome.storage.local.set({ token: result.token, extensionId: result.extensionId, sources: [] }); selectedSources = []; renderChannels(); } catch (error) { backdrop.querySelector('#error').textContent = error.message; } };
    return;
  }
  renderChannels();
}
async function renderChannels() {
  const root = document.getElementById('signal-pilot-discord-root'); const backdrop = root.shadowRoot.querySelector('.backdrop'); const channels = discoverChannels(); await loadSources();
  const selected = new Set(selectedSources.map((source) => `${source.serverId}:${source.channelId}`));
  backdrop.innerHTML = `<section class="card"><div class="head"><div><span class="eyebrow">CONNECTED TO SACRED SOUL</span><h2>Choose signal channels</h2><p>Only checked channels will be monitored. Switch Discord servers, reopen this panel, and add more anytime.</p></div><button class="secondary" id="close">Close</button></div><div id="channels">${channels.length ? channels.map((channel) => `<label class="channel"><input type="checkbox" data-key="${channel.serverId}:${channel.channelId}" ${selected.has(`${channel.serverId}:${channel.channelId}`) ? 'checked' : ''}><span><b># ${escapeHtml(channel.channelName)}</b><small>${escapeHtml(channel.serverName)} · ${channel.channelId}</small></span></label>`).join('') : '<p class="error">No channels found. Open a Discord server and try again.</p>'}</div><div class="actions"><button class="primary" id="save">Save selected channels</button><button class="secondary" id="refresh">Refresh list</button></div><p class="hint" id="status"></p></section>`;
  backdrop.querySelector('#close').onclick = closePanel; backdrop.querySelector('#refresh').onclick = renderChannels;
  backdrop.querySelector('#save').onclick = async () => { const save = backdrop.querySelector('#save'); const checked = new Set([...backdrop.querySelectorAll('input:checked')].map((node) => node.dataset.key)); const retained = selectedSources.filter((source) => !channels.some((item) => `${item.serverId}:${item.channelId}` === `${source.serverId}:${source.channelId}`)); const next = [...retained, ...channels.filter((channel) => checked.has(`${channel.serverId}:${channel.channelId}`))]; try { save.disabled = true; save.textContent = 'Saving…'; const result = await callApi('/api/extension/discord-sources', { method: 'POST', body: JSON.stringify({ sources: next }) }); selectedSources = result.sources; await chrome.storage.local.set({ sources: result.sources }); closePanel(); chrome.runtime.sendMessage({ type: 'SACRED_SOUL_SHOW_SOURCES' }); } catch (error) { save.disabled = false; save.textContent = 'Save selected channels'; backdrop.querySelector('#status').textContent = error.message; } };
}
async function autoPairFromHash() {
  const match = location.hash.match(/signalpilot-pair=([A-Za-z0-9]{8})/i); if (!match) return;
  try { const result = await callApi('/api/extension/pair', { method: 'POST', body: JSON.stringify({ pairingCode: match[1] }) }); await chrome.storage.local.set({ token: result.token, extensionId: result.extensionId, sources: [] }); history.replaceState(null, '', `${location.pathname}${location.search}`); setTimeout(openPanel, 600); } catch { setTimeout(openPanel, 600); }
}
function signalPattern(message) {
  const value = String(message || '').toUpperCase().replace(/\s+/g, ' ');
  const symbol = '\\b(XAUUSD|EURUSD|GBPUSD|GOLD|XAU|EU|GU)\\b';
  if (!new RegExp(symbol).test(value)) return null;
  if (new RegExp(`\\b(BUY|SELL|LONG|SHORT)\\s+${symbol}.*\\b(?:CMP|AT|@|ENTRY)\\b.*\\b(?:SL|STOP(?:\\s+LOSS)?)\\b`).test(value)) return 'ENTRY';
  if (/\\b(?:TRADE\\s+)?(?:CLOSE|CLOSED|EXIT|CANCEL)\\b/.test(value) || value.includes('STOP LOSS HIT') || value.includes('SL HIT')) return 'CLOSE';
  if (/\\b(?:MOVE|SHIFT|SET|ADJUST|CHANGE)\\b.*\\b(?:SL|STOP(?:\\s+LOSS)?)\\b/.test(value) || /\\b(?:SL|STOP(?:\\s+LOSS)?)\\b.*\\b(?:BREAKEVEN|BREAK\\s+EVEN)\\b/.test(value)) return 'UPDATE_STOP';
  if (/\\b(?:MOVE|SHIFT|SET|ADJUST|CHANGE)\\b.*\\b(?:TP|TAKE\\s*PROFIT)\\b/.test(value)) return 'UPDATE_TARGET';
  return null;
}
async function sendMessage(message, messageId) { const active = route(); if (!active) return; const source = selectedSources.find((item) => item.serverId === active.serverId && item.channelId === active.channelId); const detectedKind = signalPattern(message); const observedOnly = source?.captureMode === 'OBSERVE'; if (!source || (!observedOnly && !detectedKind)) return; callApi('/api/extension/discord-message', { method: 'POST', body: JSON.stringify({ ...active, message, messageId, detectedKind, observedOnly }) }).catch(() => undefined); }
function observeMessages() { document.querySelectorAll('[id^="message-content-"]').forEach((node) => initialMessageIds.add(node.id)); new MutationObserver((entries) => entries.forEach((entry) => entry.addedNodes.forEach((node) => { if (!(node instanceof Element)) return; const messages = node.matches?.('[id^="message-content-"]') ? [node] : Array.from(node.querySelectorAll?.('[id^="message-content-"]') || []); messages.forEach((message) => { if (!initialMessageIds.has(message.id)) { initialMessageIds.add(message.id); sendMessage(message.textContent || '', message.id.replace(/^message-content-/, '')); } }); }))).observe(document.documentElement, { childList: true, subtree: true }); }
chrome.runtime.onMessage.addListener((message, sender, reply) => { if (message.type === 'DISCOVER_CHANNELS') { reply({ channels: discoverChannels() }); return; } if (message.type === 'WATCH_SOURCES') { selectedSources = message.sources || []; reply({ ok: true }); } });
loadSources().then(() => { mount(); observeMessages(); autoPairFromHash(); syncSources().catch(() => undefined); setInterval(() => syncSources().catch(() => undefined), 10000); });
