const API_BASE = process.env.XBTFX_API_BASE || 'https://interface.xbtfx.com';

function xbtfxConfiguration() {
  const keyPresent = Boolean(process.env.XBTFX_API_KEY);
  return {
    provider: 'XBTFX',
    apiBase: API_BASE,
    keyPresent,
    mode: process.env.XBTFX_LIVE_ENABLED === 'true' ? 'LIVE_REQUESTED' : 'DEMO_ONLY',
    ready: keyPresent && process.env.XBTFX_LIVE_ENABLED === 'true'
  };
}

function buildOrder(trade) {
  return {
    symbol: trade.symbol,
    side: trade.side,
    volume: trade.lots,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    clientOrderId: trade.id
  };
}

// Phase 2 deliberately does not make an outbound order request. This gives the
// app a stable broker-order contract while the full demo validation workflow is built.
function queueDemoOrder(trade) {
  return {
    provider: 'XBTFX',
    mode: 'DEMO',
    state: 'QUEUED',
    order: buildOrder(trade),
    message: 'Broker order is queued for the XBTFX demo connector. No live request was sent.'
  };
}

module.exports = { xbtfxConfiguration, buildOrder, queueDemoOrder };
