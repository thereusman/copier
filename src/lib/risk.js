function calculateLot({ trade, settings }) {
  const stopDistance = Math.abs(trade.entry - trade.stopLoss);
  // Conservative Phase 1 approximation. Phase 2 will use broker symbol metadata/tick values.
  const assumedValuePerPriceUnit = trade.symbol === 'XAUUSD' ? 100 : 100000;
  const riskMoney = settings.accountBalance * (settings.riskPercent / 100);
  const rawLots = riskMoney / (stopDistance * assumedValuePerPriceUnit);
  return Math.min(Math.max(Number(rawLots.toFixed(2)), 0.01), settings.maxLots);
}

function dayLoss(trades) {
  const today = new Date().toISOString().slice(0, 10);
  return trades.filter((trade) => trade.createdAt.startsWith(today) && trade.pnl < 0)
    .reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
}

function assess({ trade, settings, trades }) {
  if (!settings.executionEnabled) return { approved: false, reason: 'Execution is paused by the operator.' };
  if (!settings.allowedSymbols.includes(trade.symbol)) return { approved: false, reason: `${trade.symbol} is not on the permitted-symbol list.` };
  if (dayLoss(trades) >= settings.maxDailyLoss) return { approved: false, reason: 'Daily-loss guard is active.' };
  const duplicate = trades.find((existing) => existing.status === 'OPEN' && existing.symbol === trade.symbol && existing.side === trade.side);
  if (duplicate) return { approved: false, reason: `Duplicate protection: an open ${trade.side} ${trade.symbol} already exists.` };
  return { approved: true, lots: calculateLot({ trade, settings }), reason: 'Passed strict parser, symbol, daily-loss, and duplicate checks.' };
}

module.exports = { assess };
