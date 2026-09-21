const api = 'http://localhost:8788';
const $ = (selector) => document.querySelector(selector);
let discovered = [];

async function stored() { return chrome.storage.local.get(['token', 'extensionId', 'sources']); }
async function request(path, options = {}) {
  const saved = await stored();
  const response = await fetch(`${api}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(saved.token ? { Authorization: `Bearer ${saved.token}` } : {}), ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

function showPairing(value) { $('#pairing').hidden = !value; $('#channels').hidden = value; }
function render() {
  const selected = new Set((window.savedSources || []).map((source) => `${source.serverId}:${source.channelId}`));
  $('#list').innerHTML = discovered.length ? discovered.map((channel) => `<label class="channel"><input type="checkbox" value="${channel.serverId}:${channel.channelId}" ${selected.has(`${channel.serverId}:${channel.channelId}`) ? 'checked' : ''}><span><b># ${escapeHtml(channel.channelName)}</b><small>${escapeHtml(channel.serverName)} · ${channel.channelId}</small></span></label>`).join('') : '<p class="empty">Open a Discord server in this browser, then press Refresh.</p>';
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char])); }
async function discover() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://discord.com/channels/')) { discovered = []; render(); return; }
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'DISCOVER_CHANNELS' });
  discovered = response?.channels || []; render();
}
async function boot() {
  const saved = await stored(); window.savedSources = saved.sources || [];
  showPairing(!saved.token);
  if (saved.token) await discover();
}
$('#pair').addEventListener('click', async () => {
  try { const result = await request('/api/extension/pair', { method: 'POST', body: JSON.stringify({ pairingCode: $('#code').value }) }); await chrome.storage.local.set({ token: result.token, extensionId: result.extensionId, sources: [] }); window.savedSources = []; showPairing(false); await discover(); } catch (error) { $('#pairing').querySelector('p').textContent = error.message; }
});
$('#refresh').addEventListener('click', discover);
$('#save').addEventListener('click', async () => {
  const selected = new Set([...document.querySelectorAll('#list input:checked')].map((node) => node.value));
  const sources = discovered.filter((source) => selected.has(`${source.serverId}:${source.channelId}`));
  try { const result = await request('/api/extension/discord-sources', { method: 'POST', body: JSON.stringify({ sources }) }); await chrome.storage.local.set({ sources: result.sources }); window.savedSources = result.sources; const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) chrome.tabs.sendMessage(tab.id, { type: 'WATCH_SOURCES', sources: result.sources }); chrome.runtime.sendMessage({ type: 'SACRED_SOUL_SHOW_SOURCES' }); } catch (error) { $('#status').textContent = error.message; }
});
boot();
