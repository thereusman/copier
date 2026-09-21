function announce() { window.postMessage({ type: 'SIGNAL_PILOT_EXTENSION_READY' }, window.location.origin); }
function runtimeAvailable() {
  try { return Boolean(chrome.runtime?.id); } catch { return false; }
}
function sendPairResult(result) {
  window.postMessage({ type: 'SACRED_SOUL_PAIR_RESULT', ...result }, window.location.origin);
}
window.addEventListener('message', (event) => {
  if (event.source === window && event.data?.type === 'SIGNAL_PILOT_EXTENSION_PING') announce();
  if (event.source === window && event.data?.type === 'SACRED_SOUL_ENSURE_PAIR') {
    if (!runtimeAvailable()) {
      sendPairResult({ ok: false, error: 'The extension was reloaded. Refresh Sacred Soul once, then try again.' });
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'SACRED_SOUL_ENSURE_PAIR', pairingCode: event.data.pairingCode }, (response) => {
        if (!runtimeAvailable() || chrome.runtime.lastError) {
          sendPairResult({ ok: false, error: 'The extension was reloaded. Refresh Sacred Soul once, then try again.' });
          return;
        }
        sendPairResult({ ok: Boolean(response?.ok), error: response?.error || null });
      });
    } catch {
      sendPairResult({ ok: false, error: 'The extension was reloaded. Refresh Sacred Soul once, then try again.' });
    }
  }
});
announce();
