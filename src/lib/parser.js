const symbolAliases = { GOLD: 'XAUUSD', XAU: 'XAUUSD', EU: 'EURUSD', GU: 'GBPUSD' };
const symbols = 'XAUUSD|EURUSD|GBPUSD|GOLD|XAU|EU|GU';

function number(value) { const parsed = Number(String(value).replace(/,/g, '')); return Number.isFinite(parsed) ? parsed : null; }
function findNumber(message, expression) { const hit = message.match(expression); return hit ? number(hit[1]) : null; }
function symbolFrom(message) { const hit = message.match(new RegExp(`\\b(${symbols})\\b`)); return hit ? (symbolAliases[hit[1]] || hit[1]) : null; }
function level(message, names) { return findNumber(message, new RegExp(`\\b(?:${names})\\s*(?:TO|:|=|@|-)?\\s*([0-9.,]+)`)); }

function parseSignal(rawMessage) {
  const message = rawMessage.trim().toUpperCase().replace(/\s+/g, ' ');
  const symbol = symbolFrom(message);
  if (!symbol) return { ok: false, reason: 'No supported symbol found.' };
  const stopLoss = level(message, 'SL|STOP(?:\\s+LOSS)?');
  const breakEven = findNumber(message, /\b(?:BREAKEVEN|BREAK\s+EVEN)\b\s*(?:\(|AT\s+|TO\s+|:|=)?\s*([0-9.,]+)/);
  const takeProfit = level(message, 'TP(?:[0-9]+)?|TAKE\\s*PROFIT');
  if (/\b(?:CLOSE|CLOSED|EXIT|CANCEL)(?:\s+(?:THE|THIS))?\b/.test(message) || /\b(?:SL|STOP(?:\s+LOSS)?)\s+(?:WAS\s+)?HIT\b/.test(message)) return { ok: true, kind: 'CLOSE', symbol, confidence: 'STRICT' };
  if (/\b(?:BREAKEVEN|BREAK\s+EVEN)\b/.test(message) && breakEven) return { ok: true, kind: 'UPDATE_STOP', symbol, stopLoss: breakEven, confidence: 'STRICT' };
  if (/\b(?:MOVE|SHIFT|SET|ADJUST|CHANGE)\b[^.]*\b(?:SL|STOP(?:\s+LOSS)?)\b/.test(message) && stopLoss) return { ok: true, kind: 'UPDATE_STOP', symbol, stopLoss, confidence: 'STRICT' };
  if (/\b(?:MOVE|SHIFT|SET|ADJUST|CHANGE)\b[^.]*\b(?:TP|TAKE\s*PROFIT)\b/.test(message) && takeProfit) return { ok: true, kind: 'UPDATE_TARGET', symbol, takeProfit, confidence: 'STRICT' };
  const sideMatch = message.match(/\b(BUY|SELL|LONG|SHORT)\b/);
  if (!sideMatch) return { ok: false, reason: 'No supported entry or trade update instruction found.' };
  const side = ['BUY', 'LONG'].includes(sideMatch[1]) ? 'BUY' : 'SELL';
  const entry = findNumber(message, new RegExp(`\\b(?:BUY|SELL|LONG|SHORT)\\s+(?:${symbols})\\s*(?:CMP|AT|@)?\\s*([0-9.,]+)`)) ?? level(message, 'ENTRY|CMP');
  if (!entry || !stopLoss) return { ok: false, reason: 'A new entry requires a price and stop loss. Example: BUY XAUUSD CMP 2365 SL 2358.' };
  if ((side === 'BUY' && !(stopLoss < entry)) || (side === 'SELL' && !(stopLoss > entry))) return { ok: false, reason: 'Stop loss is invalid for the declared trade direction.' };
  if (takeProfit && ((side === 'BUY' && !(takeProfit > entry)) || (side === 'SELL' && !(takeProfit < entry)))) return { ok: false, reason: 'Take profit is invalid for the declared trade direction.' };
  return { ok: true, kind: 'ENTRY', trade: { side, symbol, entry, stopLoss, takeProfit: takeProfit || null, orderType: 'MARKET', confidence: takeProfit ? 'STRICT' : 'PARTIAL_TARGET' } };
}

module.exports = { parseSignal };
