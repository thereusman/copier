const api = 'http://localhost:8788';

async function showSourcesDashboard() {
  // A unique query value makes an already-open dashboard fetch its newest source state.
  const dashboardUrl = `${api}/app?sourceSync=${Date.now()}#sources`;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => /^http:\/\/localhost:8788\/app(?:\.html)?(?:[/?#]|$)/.test(tab.url || ''));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true, url: dashboardUrl });
    return;
  }
  await chrome.tabs.create({ url: dashboardUrl });
}

async function request(path, options = {}) {
  const saved = await chrome.storage.local.get(['token']);
  const response = await fetch(`${api}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(saved.token ? { Authorization: `Bearer ${saved.token}` } : {}), ...(options.headers || {}) }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Signal Pilot could not complete this request.');
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'SIGNAL_PILOT_API') {
    request(message.path, message.options || {})
      .then((data) => reply({ ok: true, data }))
      .catch((error) => reply({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'SACRED_SOUL_ENSURE_PAIR') {
    chrome.storage.local.get(['token', 'extensionId']).then(async (saved) => {
      if (saved.token) { reply({ ok: true, reused: true }); return; }
      try {
        const data = await request('/api/extension/pair', { method: 'POST', body: JSON.stringify({ pairingCode: message.pairingCode }) });
        await chrome.storage.local.set({ token: data.token, extensionId: data.extensionId, sources: [] });
        reply({ ok: true, reused: false });
      } catch (error) { reply({ ok: false, error: error.message }); }
    });
    return true;
  }
  if (message.type === 'SACRED_SOUL_SHOW_SOURCES') {
    showSourcesDashboard()
      .then(() => reply({ ok: true }))
      .catch((error) => reply({ ok: false, error: error.message }));
    return true;
  }
});
