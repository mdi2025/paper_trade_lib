import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';

// --- State Management ---
const STORAGE_KEY = 'btc_paper_trader_state_v2';

const defaultState = {
  cash: 10000.0,
  positions: {}, // e.g. { 'BTCUSDT': { amount: 0, avgEntryPrice: 0 }, 'BTC-260626-140000-C': { amount: 0, avgEntryPrice: 0 } }
  history: [], 
};

let state = JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultState;
if (state.crypto !== undefined) { // Migration from v1
  state = defaultState;
}

let activeSymbol = 'BTCUSDT';
let currentPrice = 0;
let latestPrices = {}; // to track prices for portfolio value
let currentWs = null;
let activeSymbolPollInterval = null;
let pnlRefreshInterval = null;

// --- DOM Elements ---
const elTotalValue = document.getElementById('total-value');
const elCashBalance = document.getElementById('cash-balance');
const elBtcHoldings = document.getElementById('btc-holdings');
const elLivePrice = document.getElementById('live-price');
const elEstimatedValue = document.getElementById('estimated-value');
const elTradeAmount = document.getElementById('trade-amount');
const elTradeFeedback = document.getElementById('trade-feedback');
const tbodyHistory = document.getElementById('history-tbody');
const tbodyPositions = document.getElementById('positions-tbody');
const btnBuy = document.getElementById('btn-buy');
const btnSell = document.getElementById('btn-sell');

const elActiveSymbolTitle = document.getElementById('active-symbol-title');
const btnSpotBtc = document.getElementById('btn-spot-btc');

const elOrderPnlGroup = document.getElementById('order-pnl-group');
const elOrderPositionSize = document.getElementById('order-position-size');
const elOrderPnlValue = document.getElementById('order-pnl-value');

// Market Stats DOM Elements
const elStatCurrent = document.getElementById('stat-current');
const elStatWeekLow = document.getElementById('stat-week-low');
const elStatWeekHigh = document.getElementById('stat-week-high');

// Options DOM Elements
const elExpirySelect = document.getElementById('expiry-select');
const tbodyOptions = document.getElementById('options-tbody');

const elNavBtcPriceValue = document.getElementById('nav-btc-price-value');

let optionsData = {}; // Grouped by Expiration Date
let availableExpiries = [];

// Initialize with sample data
function initSampleOptionsData() {
  const today = new Date();
  const expiry1 = `${String(today.getFullYear()).slice(2)}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const expiry2Date = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiry2 = `${String(expiry2Date.getFullYear()).slice(2)}${String(expiry2Date.getMonth() + 1).padStart(2, '0')}${String(expiry2Date.getDate()).padStart(2, '0')}`;
  
  const basePrice = 43000;
  const strikes = [41000, 42000, 43000, 44000, 45000];
  
  optionsData = {};
  [expiry1, expiry2].forEach(expiry => {
    optionsData[expiry] = {};
    strikes.forEach(strike => {
      const callValue = Math.max(100, basePrice - strike + 50);
      const putValue = Math.max(100, strike - basePrice + 50);
      optionsData[expiry][strike] = {
        C: { 
          symbol: `BTC-${expiry}-${strike}-C`, 
          lastPrice: callValue, 
          bidPrice: callValue * 0.95, 
          askPrice: callValue * 1.05 
        },
        P: { 
          symbol: `BTC-${expiry}-${strike}-P`, 
          lastPrice: putValue, 
          bidPrice: putValue * 0.95, 
          askPrice: putValue * 1.05 
        }
      };
    });
  });
  
  availableExpiries = [expiry1, expiry2];
}

function updateNavBtcPrice(price) {
  if (!elNavBtcPriceValue) return;
  if (isNaN(price) || price <= 0) return;
  elNavBtcPriceValue.innerText = formatUSD(price);
}

// --- Formatters ---
const formatUSD = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
const formatCrypto = (val) => val.toFixed(8);
const formatTime = (ts) => new Date(ts).toLocaleTimeString();

// --- Chart Initialization ---
const chartContainer = document.getElementById('tvchart');
const chart = createChart(chartContainer, {
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: '#94a3b8',
  },
  grid: {
    vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
    horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
  },
  crosshair: {
    mode: 0,
  },
  rightPriceScale: {
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  timeScale: {
    borderColor: 'rgba(255, 255, 255, 0.1)',
    timeVisible: true,
    secondsVisible: false,
  },
});

const candleSeries = chart.addSeries(CandlestickSeries, {
  upColor: '#10b981',
  downColor: '#ef4444',
  borderDownColor: '#ef4444',
  borderUpColor: '#10b981',
  wickDownColor: '#ef4444',
  wickUpColor: '#10b981',
});

// Handle resize
new ResizeObserver(entries => {
  if (entries.length === 0 || entries[0].target !== chartContainer) { return; }
  const newRect = entries[0].contentRect;
  chart.applyOptions({ height: newRect.height, width: newRect.width });
}).observe(chartContainer);

// --- Fetch Initial History Data ---
async function fetchActiveSymbolPriceREST() {
  try {
    const res = activeSymbol.includes('-')
      ? await fetch(`/eapi/v1/ticker/price?symbol=${activeSymbol}`)
      : await fetch(`/api/v3/ticker/price?symbol=${activeSymbol}`);

    const data = await res.json();
    const price = parseFloat(data.price ?? data.lastPrice ?? data.close);
    if (!isNaN(price)) {
      const updated = price !== currentPrice;
      currentPrice = price;
      latestPrices[activeSymbol] = currentPrice;
      elLivePrice.classList.remove('loading', 'up', 'down');
      elLivePrice.innerText = formatUSD(currentPrice);
      if (activeSymbol === 'BTCUSDT') {
        updateNavBtcPrice(currentPrice);
      }
      if (updated) updateUI();
    }
  } catch (error) {
    console.error('Active symbol REST fallback failed:', error);
  }
}

function stopActiveSymbolPolling() {
  if (activeSymbolPollInterval) {
    clearInterval(activeSymbolPollInterval);
    activeSymbolPollInterval = null;
  }
}

function startActiveSymbolPolling() {
  stopActiveSymbolPolling();
  activeSymbolPollInterval = setInterval(fetchActiveSymbolPriceREST, 1000);
}

function stopRealtimePnLRefresh() {
  if (pnlRefreshInterval) {
    clearInterval(pnlRefreshInterval);
    pnlRefreshInterval = null;
  }
}

async function fetchOpenPositionPrices() {
  const openSymbols = Object.keys(state.positions).filter(sym => state.positions[sym].amount > 0);
  if (openSymbols.length === 0) return;

  await Promise.all(openSymbols.map(async (symbol) => {
    try {
      const url = symbol.includes('-')
        ? `/eapi/v1/ticker/price?symbol=${symbol}`
        : `/api/v3/ticker/price?symbol=${symbol}`;
      const res = await fetch(url);
      const data = await res.json();
      const price = parseFloat(data.price ?? data.lastPrice ?? data.close);
      if (!isNaN(price)) {
        latestPrices[symbol] = price;
      }
    } catch (error) {
      console.error(`Failed to refresh price for ${symbol}:`, error);
    }
  }));
}

function refreshRealtimePnL() {
  const hasOpenPositions = Object.values(state.positions).some(pos => pos.amount > 0);
  if (!hasOpenPositions) return;

  fetchOpenPositionPrices()
    .then(() => updateUI())
    .catch(() => updateUI());
}

function startRealtimePnLRefresh() {
  stopRealtimePnLRefresh();
  pnlRefreshInterval = setInterval(refreshRealtimePnL, 1000);
}

async function fetchHistoricalData() {
  try {
    const isOption = activeSymbol.includes('-');
    const baseUrl = isOption ? '/eapi/v1/klines' : '/api/v3/klines';
    
    const res = await fetch(`${baseUrl}?symbol=${activeSymbol}&interval=1m&limit=500`);
    const data = await res.json();
    if (data.code) throw new Error(data.msg);

    const formattedData = data.map(d => ({
      time: d[0] / 1000,
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
    }));
    candleSeries.setData(formattedData);
    if (formattedData.length > 0) {
      currentPrice = formattedData[formattedData.length - 1].close;
      latestPrices[activeSymbol] = currentPrice;
      updateUI();
    }
  } catch (error) {
    console.error('Error fetching historical data:', error);
    showFeedback('Failed to load historical data', 'error');
    await fetchActiveSymbolPriceREST();
  }
}

// --- WebSocket connection ---
function connectWebSocket() {
  if (currentWs) {
    currentWs.onclose = null; // Prevent reconnect loop on intentional close
    currentWs.close();
  }

  const isOption = activeSymbol.includes('-');
  const wsUrl = isOption 
    ? `wss://eapi.binance.com/eapi/ws/${activeSymbol.toLowerCase()}@kline_1m`
    : `wss://stream.binance.com:9443/ws/${activeSymbol.toLowerCase()}@kline_1m`;

  const ws = new WebSocket(wsUrl);
  currentWs = ws;
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const kline = message.k;
    
    const candleData = {
      time: kline.t / 1000,
      open: parseFloat(kline.o),
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: parseFloat(kline.c),
    };
    
    candleSeries.update(candleData);
    
    // Update live price
    const newPrice = candleData.close;
    if (newPrice !== currentPrice) {
      elLivePrice.classList.remove('loading', 'up', 'down');
      if (newPrice > currentPrice) {
        elLivePrice.classList.add('up');
      } else if (newPrice < currentPrice) {
        elLivePrice.classList.add('down');
      }
      currentPrice = newPrice;
      latestPrices[activeSymbol] = currentPrice;
      elLivePrice.innerText = formatUSD(currentPrice);
      if (activeSymbol === 'BTCUSDT') {
        updateNavBtcPrice(currentPrice);
      }
      updateUI();
    }
  };

  ws.onerror = async (error) => {
    console.error('WebSocket Error:', error);
    elLivePrice.innerText = 'Disconnected';
    await fetchActiveSymbolPriceREST();
  };
  
  ws.onclose = () => {
    console.log('WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  };
}

// Global BTC WebSocket for Navbar
let globalBtcWs = null;

async function fetchGlobalBtcPriceREST() {
  try {
    const res = await fetch('/api/v3/ticker/price?symbol=BTCUSDT');
    const data = await res.json();
    const price = parseFloat(data.price);
    if (!isNaN(price)) {
      latestPrices['BTCUSDT'] = price;
      updateNavBtcPrice(price);
      if (activeSymbol === 'BTCUSDT') {
        currentPrice = price;
        elLivePrice.classList.remove('loading', 'up', 'down');
        elLivePrice.innerText = formatUSD(currentPrice);
        updateUI();
      }
    }
  } catch (error) {
    console.error('REST fallback failed:', error);
  }
}

function connectGlobalBtcWebSocket() {
  if (globalBtcWs) {
    globalBtcWs.onclose = null;
    globalBtcWs.close();
  }
  globalBtcWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
  
  let restInterval = null;

  globalBtcWs.onopen = () => {
    if (restInterval) {
      clearInterval(restInterval);
      restInterval = null;
    }
  };

  globalBtcWs.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message && message.c) {
        const price = parseFloat(message.c);
        latestPrices['BTCUSDT'] = price;
        updateNavBtcPrice(price);
        if (activeSymbol === 'BTCUSDT') {
          currentPrice = price;
          elLivePrice.classList.remove('loading', 'up', 'down');
          elLivePrice.innerText = formatUSD(currentPrice);
          updateUI();
        }
      }
    } catch (e) {
      console.error('Error parsing BTC ticker data:', e);
    }
  };
  
  globalBtcWs.onerror = () => {
    fetchGlobalBtcPriceREST();
  };
  
  globalBtcWs.onclose = () => {
    fetchGlobalBtcPriceREST();
    if (!restInterval) {
      // Start fallback polling while waiting for reconnect
      restInterval = setInterval(fetchGlobalBtcPriceREST, 3000);
    }
    setTimeout(connectGlobalBtcWebSocket, 5000);
  };
}

// --- Fetch Options Data ---
async function fetchOptionsData() {
  try {
    const res = await fetch('/eapi/v1/ticker');
    const data = await res.json();
    
    const parsedData = {};
    const strikesSet = new Set();
    const expiriesSet = new Set();

    data.forEach(ticker => {
      const parts = ticker.symbol.split('-');
      if (parts.length !== 4 || parts[0] !== 'BTC') return;
      
      latestPrices[ticker.symbol] = parseFloat(ticker.lastPrice);

      const expiry = parts[1];
      const strike = parseInt(parts[2]);
      const type = parts[3]; 

      expiriesSet.add(expiry);
      strikesSet.add(strike);

      if (!parsedData[expiry]) parsedData[expiry] = {};
      if (!parsedData[expiry][strike]) parsedData[expiry][strike] = { C: null, P: null };

      parsedData[expiry][strike][type] = ticker;
    });

    optionsData = parsedData;
    availableExpiries = Array.from(expiriesSet).sort();

    if (elExpirySelect.options.length <= 1) {
      populateExpiryDropdown();
    } else {
      renderOptionsChain();
    }
    updateUI();
  } catch (error) {
    console.error('Error fetching options data:', error);
    // Fallback: Generate sample options data for display
    const today = new Date();
    const expiry1 = `${String(today.getFullYear()).slice(2)}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const expiry2Date = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const expiry2 = `${String(expiry2Date.getFullYear()).slice(2)}${String(expiry2Date.getMonth() + 1).padStart(2, '0')}${String(expiry2Date.getDate()).padStart(2, '0')}`;
    
    const basePrice = Math.floor(currentPrice || 43000);
    const strikes = [
      Math.floor(basePrice - 2000),
      Math.floor(basePrice - 1000),
      Math.floor(basePrice),
      Math.floor(basePrice + 1000),
      Math.floor(basePrice + 2000)
    ].filter(s => s > 0);
    
    optionsData = {};
    [expiry1, expiry2].forEach(expiry => {
      optionsData[expiry] = {};
      strikes.forEach(strike => {
        const callValue = Math.max(100, basePrice - strike + 50);
        const putValue = Math.max(100, strike - basePrice + 50);
        optionsData[expiry][strike] = {
          C: { 
            symbol: `BTC-${expiry}-${strike}-C`, 
            lastPrice: callValue, 
            bidPrice: callValue * 0.95, 
            askPrice: callValue * 1.05 
          },
          P: { 
            symbol: `BTC-${expiry}-${strike}-P`, 
            lastPrice: putValue, 
            bidPrice: putValue * 0.95, 
            askPrice: putValue * 1.05 
          }
        };
      });
    });
    
    availableExpiries = [expiry1, expiry2];
    console.log('Sample options data generated:', optionsData);
    populateExpiryDropdown();
    updateUI();
    showFeedback('Showing sample options data (real data unavailable)', 'warning');
  }
}

function populateExpiryDropdown() {
  if (availableExpiries.length === 0) return;
  
  elExpirySelect.innerHTML = '';
  availableExpiries.forEach(exp => {
    const option = document.createElement('option');
    option.value = exp;
    
    const yy = exp.substring(0, 2);
    const mm = exp.substring(2, 4);
    const dd = exp.substring(4, 6);
    option.innerText = `20${yy}-${mm}-${dd}`;
    
    elExpirySelect.appendChild(option);
  });

  elExpirySelect.value = availableExpiries[0];
  renderOptionsChain();
}

function renderOptionsChain() {
  const selectedExpiry = elExpirySelect.value;
  if (!selectedExpiry) {
    console.warn('No expiry selected');
    return;
  }
  if (!optionsData[selectedExpiry]) {
    console.warn('No options data for expiry:', selectedExpiry);
    return;
  }

  tbodyOptions.innerHTML = '';
  const expiryData = optionsData[selectedExpiry];
  const strikes = Object.keys(expiryData).map(Number).sort((a, b) => a - b);

  let atmStrike = strikes[0];
  if (currentPrice > 0) {
    let minDiff = Math.abs(currentPrice - strikes[0]);
    strikes.forEach(s => {
      const diff = Math.abs(currentPrice - s);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = s;
      }
    });
  }

  strikes.forEach(strike => {
    const callData = expiryData[strike].C || {};
    const putData = expiryData[strike].P || {};

    const tr = document.createElement('tr');
    if (currentPrice > 0 && strike === atmStrike) {
      tr.classList.add('atm-row');
    }
    
    // Call cells
    const tdCallBid = document.createElement('td'); tdCallBid.className = 'call-col'; tdCallBid.innerText = formatUSD(callData.bidPrice || 0);
    const tdCallAsk = document.createElement('td'); tdCallAsk.className = 'call-col'; tdCallAsk.innerText = formatUSD(callData.askPrice || 0);
    const tdCallLast = document.createElement('td'); tdCallLast.className = 'call-col font-bold'; tdCallLast.innerText = formatUSD(callData.lastPrice || 0);
    
    if (callData.symbol) {
      const clickHandler = () => switchTradingSymbol(callData.symbol);
      tdCallBid.onclick = clickHandler;
      tdCallAsk.onclick = clickHandler;
      tdCallLast.onclick = clickHandler;
    }

    // Strike cell
    const tdStrike = document.createElement('td'); tdStrike.className = 'strike-col'; tdStrike.innerText = formatUSD(strike);

    // Put cells
    const tdPutLast = document.createElement('td'); tdPutLast.className = 'put-col font-bold'; tdPutLast.innerText = formatUSD(putData.lastPrice || 0);
    const tdPutBid = document.createElement('td'); tdPutBid.className = 'put-col'; tdPutBid.innerText = formatUSD(putData.bidPrice || 0);
    const tdPutAsk = document.createElement('td'); tdPutAsk.className = 'put-col'; tdPutAsk.innerText = formatUSD(putData.askPrice || 0);

    if (putData.symbol) {
      const clickHandler = () => switchTradingSymbol(putData.symbol);
      tdPutLast.onclick = clickHandler;
      tdPutBid.onclick = clickHandler;
      tdPutAsk.onclick = clickHandler;
    }

    tr.appendChild(tdCallBid);
    tr.appendChild(tdCallAsk);
    tr.appendChild(tdCallLast);
    tr.appendChild(tdStrike);
    tr.appendChild(tdPutLast);
    tr.appendChild(tdPutBid);
    tr.appendChild(tdPutAsk);
    
    tbodyOptions.appendChild(tr);
  });
}

function switchTradingSymbol(symbol) {
  activeSymbol = symbol;
  elActiveSymbolTitle.innerText = activeSymbol;
  elLivePrice.innerText = 'Loading...';
  elLivePrice.className = 'live-price loading';
  
  btnSpotBtc.style.display = activeSymbol === 'BTCUSDT' ? 'none' : 'block';
  startActiveSymbolPolling();

  // Switch tab visually
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-target="view-trading"]').classList.add('active');
  document.querySelectorAll('.view-section').forEach(v => {
    v.classList.remove('active-view');
    v.style.display = 'none';
  });
  const tradingView = document.getElementById('view-trading');
  tradingView.classList.add('active-view');
  tradingView.style.display = 'flex';

  setTimeout(() => {
    const newRect = chartContainer.getBoundingClientRect();
    chart.applyOptions({ height: newRect.height, width: newRect.width });
  }, 0);

  fetchHistoricalData().then(() => connectWebSocket());
  updateMarketStats();
  updateUI();
}

async function updateMarketStats() {
  if (!elStatWeekLow || !elStatWeekHigh) return;
  elStatWeekLow.value = 'Loading...';
  elStatWeekHigh.value = 'Loading...';
  
  try {
    const isOption = activeSymbol.includes('-');
    const baseUrl = isOption ? '/eapi/v1/klines' : '/api/v3/klines';
    
    const res = await fetch(`${baseUrl}?symbol=${activeSymbol}&interval=1d&limit=7`);
    const data = await res.json();
    
    if (data && !data.code && data.length > 0) {
      let weekLow = Infinity;
      let weekHigh = -Infinity;
      
      data.forEach(candle => {
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        if (low < weekLow) weekLow = low;
        if (high > weekHigh) weekHigh = high;
      });
      
      elStatWeekLow.value = formatUSD(weekLow);
      elStatWeekHigh.value = formatUSD(weekHigh);
    } else {
      elStatWeekLow.value = 'N/A';
      elStatWeekHigh.value = 'N/A';
    }
  } catch (error) {
    console.error('Error fetching market stats:', error);
    elStatWeekLow.value = 'Error';
    elStatWeekHigh.value = 'Error';
  }
}

elExpirySelect.addEventListener('change', renderOptionsChain);
btnSpotBtc.addEventListener('click', () => switchTradingSymbol('BTCUSDT'));

document.querySelectorAll('.refresh-data-btn').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    const target = e.currentTarget;
    target.disabled = true;
    await fetchOptionsData();
    target.disabled = false;
  });
});

// --- Update UI ---
function updateUI() {
  let cryptoValue = 0;
  Object.keys(state.positions).forEach(sym => {
    const pos = state.positions[sym];
    const price = sym === activeSymbol ? currentPrice : (latestPrices[sym] || pos.avgEntryPrice);
    cryptoValue += (pos.amount * price);
  });

  const totalValue = state.cash + cryptoValue;
  
  elTotalValue.innerText = formatUSD(totalValue);
  elCashBalance.innerText = formatUSD(state.cash);
  
  const activePos = state.positions[activeSymbol];
  elBtcHoldings.innerText = activePos ? formatCrypto(activePos.amount) : '0.00000000';
  document.querySelector('.summary-item:last-child .label').innerText = `${activeSymbol} Holdings`;
  
  if (activePos && activePos.amount > 0) {
    elOrderPnlGroup.style.display = 'block';
    elOrderPositionSize.innerText = formatCrypto(activePos.amount);
    const pnl = (currentPrice - activePos.avgEntryPrice) * activePos.amount;
    const pnlClass = pnl >= 0 ? 'type-buy' : 'type-sell';
    const pnlPrefix = pnl >= 0 ? '+' : '';
    elOrderPnlValue.innerText = `${pnlPrefix}${formatUSD(pnl)}`;
    elOrderPnlValue.className = pnlClass;
  } else {
    elOrderPnlGroup.style.display = 'none';
  }

  updateEstimatedValue();
  if (activeSymbol === 'BTCUSDT' && currentPrice > 0) {
    updateNavBtcPrice(currentPrice);
  }
  renderPositions();
  renderHistory();
  
  if (elStatCurrent) {
    elStatCurrent.value = currentPrice > 0 ? formatUSD(currentPrice) : 'Loading...';
  }
  
  saveState();
}

function updateEstimatedValue() {
  const amount = parseFloat(elTradeAmount.value) || 0;
  elEstimatedValue.innerText = formatUSD(amount * currentPrice);
}

function renderPositions() {
  tbodyPositions.innerHTML = '';

  Object.keys(state.positions).forEach(sym => {
    const pos = state.positions[sym];
    if (pos.amount <= 0) return;

    const price = sym === activeSymbol ? currentPrice : (latestPrices[sym] || pos.avgEntryPrice);
    const pnl = (price - pos.avgEntryPrice) * pos.amount;
    const pnlClass = pnl >= 0 ? 'type-buy' : 'type-sell';
    const pnlPrefix = pnl >= 0 ? '+' : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${sym}</td>
      <td>${formatCrypto(pos.amount)}</td>
      <td>${formatUSD(pos.avgEntryPrice)}</td>
      <td>${formatUSD(price)}</td>
      <td class="${pnlClass}">${pnlPrefix}${formatUSD(pnl)}</td>
      <td><button class="btn sell-btn close-btn" data-symbol="${sym}">Close</button></td>
    `;
    tbodyPositions.appendChild(tr);
  });

  document.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sym = e.target.getAttribute('data-symbol');
      closePosition(sym);
    });
  });
}

function renderHistory() {
  tbodyHistory.innerHTML = '';
  const displayHistory = [...state.history].reverse().slice(0, 50);
  
  displayHistory.forEach(trade => {
    const tr = document.createElement('tr');
    
    let pnlHtml = '-';
    if (trade.pnl !== undefined) {
      const pnlClass = trade.pnl >= 0 ? 'type-buy' : 'type-sell';
      const pnlPrefix = trade.pnl >= 0 ? '+' : '';
      pnlHtml = `<span class="${pnlClass}">${pnlPrefix}${formatUSD(trade.pnl)}</span>`;
    }

    tr.innerHTML = `
      <td class="type-${trade.type.toLowerCase()}">${trade.type}</td>
      <td>${trade.symbol}</td>
      <td>${formatUSD(trade.price)}</td>
      <td>${formatCrypto(trade.amount)}</td>
      <td>${pnlHtml}</td>
      <td>${formatTime(trade.timestamp)}</td>
    `;
    tbodyHistory.appendChild(tr);
  });
}

function showFeedback(msg, type) {
  elTradeFeedback.innerText = msg;
  elTradeFeedback.className = `feedback-msg ${type}`;
  setTimeout(() => {
    elTradeFeedback.innerText = '';
  }, 3000);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function closePosition(symbol) {
  const pos = state.positions[symbol];
  if (!pos || pos.amount <= 0) return;

  const price = symbol === activeSymbol ? currentPrice : (latestPrices[symbol] || pos.avgEntryPrice);
  if (price <= 0) {
    showFeedback('Waiting for price...', 'error');
    return;
  }

  const amount = pos.amount;
  const valueUSD = amount * price;
  const realizedPnl = (price - pos.avgEntryPrice) * amount;

  state.cash += valueUSD;
  pos.amount = 0.0;
  pos.avgEntryPrice = 0.0;
  latestPrices[symbol] = price;

  state.history.push({
    type: 'SELL',
    symbol: symbol,
    price: price,
    amount,
    pnl: realizedPnl,
    timestamp: Date.now()
  });

  showFeedback(`Successfully closed ${symbol} position`, 'success');
  updateUI();
}

// --- Trading Logic ---
function executeTrade(type) {
  if (currentPrice <= 0) {
    showFeedback('Waiting for live price...', 'error');
    return;
  }
  
  const amount = parseFloat(elTradeAmount.value);
  if (isNaN(amount) || amount <= 0) {
    showFeedback('Enter a valid amount', 'error');
    return;
  }

  const valueUSD = amount * currentPrice;
  if (!state.positions[activeSymbol]) {
    state.positions[activeSymbol] = { amount: 0, avgEntryPrice: 0 };
  }
  const pos = state.positions[activeSymbol];

  let realizedPnl = null;
  if (type === 'BUY') {
    if (valueUSD > state.cash) {
      showFeedback('Insufficient USD balance', 'error');
      return;
    }
    const totalCostBefore = pos.amount * pos.avgEntryPrice;
    const newTotalCost = totalCostBefore + valueUSD;
    state.cash -= valueUSD;
    pos.amount += amount;
    pos.avgEntryPrice = newTotalCost / pos.amount;
    // Ensure we have a recent market price stored for this symbol
    latestPrices[activeSymbol] = currentPrice;
  } else if (type === 'SELL') {
    if (amount > pos.amount) {
      showFeedback(`Insufficient ${activeSymbol} balance`, 'error');
      return;
    }
    realizedPnl = (currentPrice - pos.avgEntryPrice) * amount;
    state.cash += valueUSD;
    pos.amount -= amount;
    if (pos.amount <= 0.00000001) { 
      pos.amount = 0.0;
      pos.avgEntryPrice = 0.0;
    }
    // Update last known price for this symbol after sell
    latestPrices[activeSymbol] = currentPrice;
  }

  const tradeRecord = {
    type,
    symbol: activeSymbol,
    price: currentPrice,
    amount,
    timestamp: Date.now()
  };
  if (realizedPnl !== null) {
    tradeRecord.pnl = realizedPnl;
  }
  state.history.push(tradeRecord);

  elTradeAmount.value = '';
  showFeedback(`Successfully ${type === 'BUY' ? 'bought' : 'sold'} ${amount} ${activeSymbol}`, 'success');
  updateUI();
}

// --- Event Listeners ---
const btnToggleChart = document.getElementById('btn-toggle-chart');
if (btnToggleChart) {
  btnToggleChart.addEventListener('click', () => {
    if (chartContainer.style.display === 'none') {
      chartContainer.style.display = 'flex';
      btnToggleChart.innerText = 'Hide Chart';
      // Force resize to fix layout
      setTimeout(() => {
        const newRect = chartContainer.getBoundingClientRect();
        chart.applyOptions({ height: newRect.height, width: newRect.width });
      }, 0);
    } else {
      chartContainer.style.display = 'none';
      btnToggleChart.innerText = 'Show Chart';
    }
  });
}

elTradeAmount.addEventListener('input', updateEstimatedValue);
btnBuy.addEventListener('click', () => executeTrade('BUY'));
btnSell.addEventListener('click', () => executeTrade('SELL'));

document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  // Ignore clicks on btnSpotBtc if handled separately, but it's a nav-btn too.
  if (!btn || btn.id === 'btn-spot-btc') return; 
  
  const targetId = btn.getAttribute('data-target');
  if (!targetId) return;

  const navBtns = document.querySelectorAll('.nav-btn:not(#btn-spot-btc)');
  const views = document.querySelectorAll('.view-section');

  navBtns.forEach(b => b.classList.remove('active'));
  views.forEach(v => {
    v.classList.remove('active-view');
    v.style.display = 'none';
  });

  btn.classList.add('active');
  
  const targetView = document.getElementById(targetId);
  if (targetView) {
    targetView.classList.add('active-view');
    targetView.style.display = 'flex';
  }

  if (targetId === 'view-trading') {
    setTimeout(() => {
      const newRect = chartContainer.getBoundingClientRect();
      chart.applyOptions({ height: newRect.height, width: newRect.width });
    }, 0);
  }
});

// --- Predictions Logic ---
const btnRefreshPredictions = document.getElementById('btn-refresh-predictions');

const ASSETS_TO_PREDICT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT'];

// ── Math primitives ──────────────────────────────────────────────
const _tanh = x => (Math.exp(2*x) - 1) / (Math.exp(2*x) + 1);
const _sigmoid = x => 1 / (1 + Math.exp(-x));

function calculateSMA(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = calculateSMA(data.slice(0, period), period);
  for (let i = period; i < data.length; i++) ema = (data[i] - ema) * k + ema;
  return ema;
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d, 0)) / period;
    al = (al * (period-1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// Returns array of RSI values (null for early candles) for divergence detection
function calculateRSISeries(closes, period = 14) {
  const results = new Array(period).fill(null);
  if (closes.length < period + 1) return results;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  results.push(al === 0 ? 100 : 100 - 100/(1 + ag/al));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(period-1) + Math.max(d,0)) / period;
    al = (al*(period-1) + Math.max(-d,0)) / period;
    results.push(al === 0 ? 100 : 100 - 100/(1 + ag/al));
  }
  return results;
}

// ATR via Wilder's smoothing
function calculateATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]), pc = parseFloat(klines[i-1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period-1) + trs[i]) / period;
  return atr;
}

// ADX (Wilder's)
function calculateADX(klines, period = 14) {
  if (klines.length < period * 2 + 1) return null;
  const trs = [], dmp = [], dmm = [];
  for (let i = 1; i < klines.length; i++) {
    const h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]);
    const ph = parseFloat(klines[i-1][2]), pl = parseFloat(klines[i-1][3]), pc = parseFloat(klines[i-1][4]);
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const up = h - ph, dn = pl - l;
    dmp.push(up > dn && up > 0 ? up : 0);
    dmm.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = trs.slice(0,period).reduce((a,b)=>a+b,0);
  let sp = dmp.slice(0,period).reduce((a,b)=>a+b,0);
  let sm = dmm.slice(0,period).reduce((a,b)=>a+b,0);
  const dxArr = [];
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr/period + trs[i];
    sp  = sp  - sp/period  + dmp[i];
    sm  = sm  - sm/period  + dmm[i];
    const dip = 100*sp/atr, dim = 100*sm/atr;
    dxArr.push(100*Math.abs(dip-dim)/(dip+dim||1));
  }
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < dxArr.length; i++) adx = (adx*(period-1)+dxArr[i])/period;
  return adx;
}

// ── Continuous scoring functions ─────────────────────────────────
function scoreTrend(sma50, sma200) {
  if (!sma50 || !sma200) return 0.5;
  return 0.5 + _tanh((sma50 - sma200) / sma200 * 10) / 2;
}
function scoreRSI(rsi) { return _sigmoid(-(rsi - 50) / 8); }
function scoreMacd(macdLine, price) { return _sigmoid(macdLine / (price || 1) * 1000); }
function scoreVolume(volSurge, sTrend) {
  if (volSurge > 2.0) return sTrend > 0.5 ? 1.0 : 0.0;
  if (volSurge > 1.5) return sTrend > 0.5 ? 0.8 : 0.2;
  if (volSurge > 1.0) return 0.55;
  return 0.5;
}
function scoreFunding(fr) {
  return fr < 0 ? 0.5 + _tanh(-fr * 5000) * 0.3 : 0.5 - _tanh(fr * 5000) * 0.3;
}

// ── RSI Divergence ───────────────────────────────────────────────
function detectDivergence(closes, rsiSeries) {
  const lb = 30;
  if (closes.length < lb || rsiSeries.length < lb) return 0;
  const pc = closes.slice(-lb), pr = rsiSeries.slice(-lb).filter(r => r !== null);
  if (pr.length < lb) return 0;
  const lows = [], highs = [];
  for (let i = 2; i < pc.length - 2; i++) {
    if (pc[i] < pc[i-1] && pc[i] < pc[i-2] && pc[i] < pc[i+1] && pc[i] < pc[i+2])
      lows.push({ p: pc[i], r: pr[i] });
    if (pc[i] > pc[i-1] && pc[i] > pc[i-2] && pc[i] > pc[i+1] && pc[i] > pc[i+2])
      highs.push({ p: pc[i], r: pr[i] });
  }
  let adj = 0;
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    if (b.p < a.p && b.r > a.r) adj += 0.12; // bullish divergence
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    if (b.p > a.p && b.r < a.r) adj -= 0.12; // bearish divergence
  }
  return adj;
}

// ── Market Regime ────────────────────────────────────────────────
function detectRegime(adx, atrPct) {
  if (atrPct > 3.5) return 'BREAKOUT';
  if (adx !== null && adx > 25) return 'TRENDING';
  if (adx !== null && adx < 18) return 'RANGING';
  return 'NEUTRAL';
}

// ── v3 Default weights (multi-source probability engine) ──────────
const DEFAULT_WEIGHTS = {
  trend: 0.15, rsi: 0.10, macd: 0.10,
  funding: 0.15, oi: 0.20, news: 0.15,
  etf: 0.10, ob: 0.05
};

// Regime overrides fold into regime-aware multipliers on top of defaults
function applyRegimeMultipliers(weights, regime) {
  const w = { ...weights };
  if (regime === 'TRENDING') { w.trend *= 1.5; w.rsi *= 0.6; }
  if (regime === 'RANGING')  { w.rsi *= 1.8; w.trend *= 0.5; }
  if (regime === 'BREAKOUT') { w.oi *= 1.4; w.rsi *= 0.4; }
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  Object.keys(w).forEach(k => w[k] /= sum); // renormalize
  return w;
}

// ── News Sentiment (CryptoPanic free API) ─────────────────────────
const BULLISH_WORDS = ['etf inflow','institutional','accumulation','rate cut','adoption','approval','halving','breakthrough','surge','rally','bullish','upgrade'];
const BEARISH_WORDS = ['etf outflow','hack','ban','selloff','liquidation','inflation','crackdown','seized','crash','bearish','downgrade','fraud'];

async function fetchNewsSentiment(symbol) {
  const ticker = symbol.replace('USDT','');
  const token  = localStorage.getItem('cryptopanic_key') || '';
  if (!token) return { score: 0.5, label: 'No API Key', headlines: [] };
  try {
    const url = `/cryptopanic/api/v1/posts/?auth_token=${token}&currencies=${ticker}&public=true&kind=news`;
    const d   = await (await fetch(url)).json();
    if (!d.results) return { score: 0.5, label: 'No Data', headlines: [] };
    let raw = 0;
    const headlines = [];
    d.results.slice(0, 20).forEach(item => {
      const title = (item.title || '').toLowerCase();
      headlines.push(item.title);
      BULLISH_WORDS.forEach(w => { if (title.includes(w)) raw += 1; });
      BEARISH_WORDS.forEach(w => { if (title.includes(w)) raw -= 1; });
    });
    const score = Math.max(0, Math.min(1, (raw + 10) / 20));
    const label = score > 0.6 ? 'Bullish News' : score < 0.4 ? 'Bearish News' : 'Neutral News';
    return { score, label, headlines: headlines.slice(0, 3) };
  } catch(_) { return { score: 0.5, label: 'Fetch Error', headlines: [] }; }
}

// ── ETF Flow Score (manual localStorage input) ────────────────────
function getETFScore() {
  const raw = parseFloat(localStorage.getItem('etf_flow_usd') || '0');
  const score = Math.max(0, Math.min(1, (raw + 500_000_000) / 1_000_000_000));
  const label = raw > 100_000_000 ? `+$${(raw/1e6).toFixed(0)}M Inflow`
              : raw < -100_000_000 ? `-$${(Math.abs(raw)/1e6).toFixed(0)}M Outflow`
              : 'ETF Neutral';
  return { score, label };
}

// ── Unified Probability Engine ────────────────────────────────────
function buildProbability(signalMap, weights) {
  // signalMap: { key: { score:0-1, label, ... } }
  // weights:   { key: weight }
  let total = 0, wSum = 0;
  Object.entries(signalMap).forEach(([k, s]) => {
    if (weights[k] != null) { total += s.score * weights[k]; wSum += weights[k]; }
  });
  return wSum > 0 ? total / wSum : 0.5;
}

// ── Top Drivers ───────────────────────────────────────────────────
function computeTopDrivers(signalMap, weights) {
  return Object.entries(signalMap)
    .filter(([k]) => weights[k] != null)
    .map(([k, s]) => ({
      key: k,
      label: s.label,
      score: s.score,
      impact: Math.abs(s.score - 0.5) * (weights[k] || 0),
      bullish: s.score > 0.5
    }))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3);
}

// ── Historical Accuracy Tracker (v3: stores per-signal scores) ────
const PRED_HIST_KEY = 'pred_history_v2';

function storePrediction(symbol, cePercent, price, signalScores) {
  const hist = JSON.parse(localStorage.getItem(PRED_HIST_KEY) || '[]');
  hist.push({ symbol, cePercent, price, signals: signalScores, ts: Date.now(), correct: null, graded: false });
  if (hist.length > 500) hist.shift();
  localStorage.setItem(PRED_HIST_KEY, JSON.stringify(hist));
}

async function gradeOldPredictions() {
  const hist = JSON.parse(localStorage.getItem(PRED_HIST_KEY) || '[]');
  const ONE_HOUR = 3600000;
  let changed = false;
  for (const e of hist) {
    if (e.graded || Date.now() - e.ts < ONE_HOUR) continue;
    try {
      const d = await (await fetch(`/api/v3/ticker/price?symbol=${e.symbol}`)).json();
      const up = parseFloat(d.price) > e.price;
      if (e.cePercent > 55) e.correct = up;
      else if (e.cePercent < 45) e.correct = !up;
      e.graded = true; changed = true;
    } catch(_) {}
  }
  if (changed) localStorage.setItem(PRED_HIST_KEY, JSON.stringify(hist));
}

function getAccuracy(symbol) {
  const hist = JSON.parse(localStorage.getItem(PRED_HIST_KEY) || '[]');
  const rel  = hist.filter(h => h.symbol === symbol && h.graded && h.correct !== null);
  if (rel.length < 3) return null;
  return { pct: Math.round(rel.filter(h => h.correct).length / rel.length * 100), total: rel.length };
}

// Per-signal accuracy (needs ≥ 15 graded entries with signal data)
function getSignalAccuracies(symbol) {
  const hist = JSON.parse(localStorage.getItem(PRED_HIST_KEY) || '[]');
  const rel  = hist.filter(h => h.symbol === symbol && h.graded && h.correct !== null && h.signals);
  if (rel.length < 15) return { data: null, needed: 15 - rel.length };
  const names = Object.keys(DEFAULT_WEIGHTS);
  const acc = {};
  names.forEach(name => {
    const samples = rel.filter(h => h.signals[name] != null);
    if (!samples.length) { acc[name] = 0.5; return; }
    const correct = samples.filter(h => (h.signals[name] > 0.5) === h.correct).length;
    acc[name] = correct / samples.length;
  });
  return { data: acc, needed: 0 };
}

function getAdaptiveWeights(symbol) {
  const { data } = getSignalAccuracies(symbol);
  if (!data) return null;
  const sum = Object.values(data).reduce((a, b) => a + b, 0);
  const w = {};
  Object.entries(data).forEach(([k, v]) => w[k] = v / sum);
  return w;
}

// ── Data fetchers ─────────────────────────────────────────────────
async function fetchKlines(symbol, interval, limit) {
  const res = await fetch(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const d = await res.json();
  if (d.code) throw new Error(d.msg);
  return d;
}

async function fetchOrderBookImbalance(symbol) {
  try {
    const d = await (await fetch(`/api/v3/depth?symbol=${symbol}&limit=100`)).json();
    if (!d.bids) return 0.5;
    const bv = d.bids.reduce((a, v) => a + parseFloat(v[1]), 0);
    const av = d.asks.reduce((a, v) => a + parseFloat(v[1]), 0);
    return bv / (bv + av);
  } catch(_) { return 0.5; }
}

async function fetchFuturesData(symbol) {
  try {
    const d = await (await fetch(`/fapi/v1/premiumIndex?symbol=${symbol}`)).json();
    return { fundingRate: parseFloat(d.lastFundingRate || 0) };
  } catch(_) { return { fundingRate: 0 }; }
}

async function fetchOIChange(symbol, currentPrice, prevPrice) {
  const OI_KEY = `oi_snap_${symbol}`;
  try {
    const d = await (await fetch(`/fapi/v1/openInterest?symbol=${symbol}`)).json();
    const curOI = parseFloat(d.openInterest);
    const prev = JSON.parse(localStorage.getItem(OI_KEY) || 'null');
    localStorage.setItem(OI_KEY, JSON.stringify({ oi: curOI, ts: Date.now() }));
    if (!prev) return { oiChangePct: 0, oiScore: 0.5, oiLabel: 'N/A' };
    const pct = (curOI - prev.oi) / (prev.oi || 1);
    const priceUp = currentPrice >= prevPrice;
    const oiUp = pct > 0.001;
    let oiScore = 0.5, oiLabel = 'Neutral';
    if (priceUp && oiUp)  { oiScore = 0.80; oiLabel = 'Longs Build'; }
    if (!priceUp && oiUp) { oiScore = 0.20; oiLabel = 'Shorts Build'; }
    if (priceUp && !oiUp) { oiScore = 0.60; oiLabel = 'Short Cover'; }
    if (!priceUp && !oiUp){ oiScore = 0.35; oiLabel = 'Long Exit'; }
    return { oiChangePct: pct, oiScore, oiLabel };
  } catch(_) { return { oiChangePct: 0, oiScore: 0.5, oiLabel: 'N/A' }; }
}

async function fetchCVD(symbol) {
  try {
    const d = await (await fetch(`/api/v3/aggTrades?symbol=${symbol}&limit=500`)).json();
    let buy = 0, sell = 0;
    d.forEach(t => { const q = parseFloat(t.q); t.m ? sell += q : buy += q; });
    return (buy + sell) === 0 ? 0.5 : buy / (buy + sell);
  } catch(_) { return 0.5; }
}

// ── Per-timeframe bull score ──────────────────────────────────────
function calcTFBull(klines) {
  if (!klines || klines.length < 40) return 0.5;
  const closes  = klines.map(k => parseFloat(k[4]));
  const volumes = klines.map(k => parseFloat(k[5]));
  const rsi  = calculateRSI(closes, 14) || 50;
  const sp   = Math.min(12, Math.floor(closes.length / 5));
  const lp   = Math.min(26, Math.floor(closes.length / 3));
  const ema_s = calculateEMA(closes, sp);
  const ema_l = calculateEMA(closes, lp);
  const macdLine = (ema_s && ema_l) ? ema_s - ema_l : 0;
  const sma_s = calculateSMA(closes, Math.min(20, Math.floor(closes.length / 3)));
  const sma_l = calculateSMA(closes, Math.min(50, Math.floor(closes.length / 2)));
  const curVol = volumes[volumes.length - 1];
  const avgVol = calculateSMA(volumes, 20) || 1;
  const sTrend = scoreTrend(sma_s, sma_l);
  return scoreRSI(rsi)*0.35 + scoreMacd(macdLine, closes.at(-1))*0.35 + sTrend*0.20 + scoreVolume(curVol/avgVol, sTrend)*0.10;
}

async function analyzeAsset(symbol) {

  try {
    // Grade old predictions & fetch all timeframes in parallel
    await gradeOldPredictions();

    const [klines5m, klines15m, klines1h, klines4h, futures, obImbalance, cvdScore] = await Promise.all([
      fetchKlines(symbol, '5m',  200).catch(() => null),
      fetchKlines(symbol, '15m', 200).catch(() => null),
      fetchKlines(symbol, '1h',  250).catch(() => null),
      fetchKlines(symbol, '4h',  200).catch(() => null),
      fetchFuturesData(symbol),
      fetchOrderBookImbalance(symbol),
      fetchCVD(symbol),
    ]);

    if (!klines1h || klines1h.length < 200) return null;

    const closes  = klines1h.map(k => parseFloat(k[4]));
    const volumes = klines1h.map(k => parseFloat(k[5]));
    const curPrice = closes.at(-1), prevPrice = closes.at(-2);

    const ma50  = calculateSMA(closes, 50);
    const ma200 = calculateSMA(closes, 200);
    const rsi   = calculateRSI(closes, 14) || 50;
    const rsiSeries = calculateRSISeries(closes, 14);
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdLine = (ema12 && ema26) ? ema12 - ema26 : 0;

    const atr14  = calculateATR(klines1h, 14);
    const adx    = calculateADX(klines1h, 14);
    const atrPct = atr14 ? (atr14 / curPrice) * 100 : 2;
    const regime = detectRegime(adx, atrPct);

    const curVol   = volumes[volumes.length - 1];
    const avgVol   = calculateSMA(volumes, 20) || 1;
    const volSurge = curVol / avgVol;

    const { oiChangePct, oiScore, oiLabel } = await fetchOIChange(symbol, curPrice, prevPrice);
    const divAdj   = detectDivergence(closes, rsiSeries);
    const sTrend   = scoreTrend(ma50, ma200);
    const sRSI     = scoreRSI(rsi);
    const sMACD    = scoreMacd(macdLine, curPrice);
    const sVol     = scoreVolume(volSurge, sTrend);
    const sFunding = scoreFunding(futures.fundingRate);

    const bull5m   = calcTFBull(klines5m);
    const bull15m  = calcTFBull(klines15m);
    const bull4h   = calcTFBull(klines4h);
    const bull1hTF = scoreRSI(rsi)*0.35 + sMACD*0.35 + sTrend*0.20 + sVol*0.10;
    const tfBull   = 0.10*bull5m + 0.20*bull15m + 0.40*bull1hTF + 0.30*bull4h;

    const newsSentiment = await fetchNewsSentiment(symbol);
    const etfData       = getETFScore();

    // ── Unified signal map ────────────────────────────────────────
    const signalMap = {
      trend:   { score: sTrend,               label: ma50 > ma200 ? 'Bullish Trend' : 'Bearish Trend' },
      rsi:     { score: sRSI,                 label: `RSI ${rsi.toFixed(1)}` },
      macd:    { score: sMACD,                label: macdLine > 0 ? 'MACD Bullish' : 'MACD Bearish' },
      funding: { score: sFunding,             label: futures.fundingRate < 0 ? 'Funding Negative' : 'Funding Positive' },
      oi:      { score: oiScore,              label: oiLabel },
      news:    { score: newsSentiment.score,  label: newsSentiment.label },
      etf:     { score: etfData.score,        label: etfData.label },
      ob:      { score: obImbalance,          label: obImbalance > 0.55 ? 'Bid Heavy' : obImbalance < 0.45 ? 'Ask Heavy' : 'Balanced Book' },
    };

    const adaptiveW  = getAdaptiveWeights(symbol);
    const weights    = applyRegimeMultipliers(adaptiveW || DEFAULT_WEIGHTS, regime);
    const isAdaptive = !!adaptiveW;

    const suiteProb = buildProbability(signalMap, weights);
    const rawBull   = 0.40*tfBull + 0.60*suiteProb + divAdj;
    let cePercent   = Math.round(Math.min(100, Math.max(0, rawBull * 100)));

    // Step 2: Multi-Timeframe Alignment
    if ((bull1hTF * 100) > 60 && (bull4h * 100) > 60) {
      cePercent = Math.max(55, cePercent);
    } else if ((bull1hTF * 100) < 40 && (bull4h * 100) < 40) {
      cePercent = Math.min(45, cePercent);
    }
    const pePercent = 100 - cePercent;

    const topDrivers = computeTopDrivers(signalMap, weights);

    // Step 3 & 4: New Confidence Calculation
    // Timeframe Agreement (tfAgreement)
    const tfVals = [bull5m, bull15m, bull1hTF, bull4h];
    const tfCount = tfVals.filter(v => cePercent >= 50 ? v >= 0.5 : v < 0.5).length;
    const tfAgreement = (tfCount / 4) * 100;

    // Signal Agreement (sigAgreement)
    const sigVals = Object.values(signalMap).map(s => s.score);
    const sigCount = sigVals.filter(v => cePercent >= 50 ? v >= 0.5 : v < 0.5).length;
    const sigAgreement = (sigCount / sigVals.length) * 100;

    // Volume Confirmation (volConfirm)
    const volConfirm = Math.min(100, Math.round(volSurge * 60));

    // Confidence Average
    const confidence = Math.round((tfAgreement + sigAgreement + volConfirm) / 3);

    // Step 1: Trade Quality Score
    const quality = Math.round(Math.abs(cePercent - pePercent) * (confidence / 100));

    // Step 5: Entry Filters
    let finalTradeStatus = 'NO TRADE';
    let tradeStatusClass = 'status-no-trade';
    const reasons = [];
    const triggers = [];

    if (cePercent >= 50) {
      // CE Buy Trade Filters
      if (cePercent <= 65) reasons.push(`CE split too narrow (${cePercent}%, needs > 65%)`);
      if (confidence <= 60) reasons.push(`Low confidence (${confidence}%, needs > 60%)`);
      if (divAdj < 0) reasons.push("Bearish divergence detected");
      if (volSurge <= 1.2) reasons.push(`Weak volume surge (${((volSurge - 1)*100).toFixed(0)}%, needs > 20%)`);
      if (cvdScore <= 0.60) reasons.push(`CVD buying power too weak (${(cvdScore*100).toFixed(0)}%, needs > 60%)`);

      if (reasons.length === 0) {
        if (quality >= 50) {
          finalTradeStatus = 'STRONG CE';
          tradeStatusClass = 'status-strong-ce';
        } else if (quality >= 30) {
          finalTradeStatus = 'CE TRADE';
          tradeStatusClass = 'status-ce';
        } else if (quality >= 15) {
          finalTradeStatus = 'SMALL CE';
          tradeStatusClass = 'status-small-ce';
        }
      } else {
        triggers.push("CE > 65%", "Confidence > 60%", "Volume Surge > 20%", "CVD > 60%", "No Bearish Divergence");
      }
    } else {
      // PE Sell Trade Filters
      if (pePercent <= 65) reasons.push(`PE split too narrow (${pePercent}%, needs > 65%)`);
      if (confidence <= 60) reasons.push(`Low confidence (${confidence}%, needs > 60%)`);
      if (divAdj > 0) reasons.push("Bullish divergence detected");
      if (volSurge <= 1.2) reasons.push(`Weak volume surge (${((volSurge - 1)*100).toFixed(0)}%, needs > 20%)`);
      if (cvdScore >= 0.40) reasons.push(`CVD selling power too weak (${(cvdScore*100).toFixed(0)}%, needs < 40%)`);

      if (reasons.length === 0) {
        if (quality >= 50) {
          finalTradeStatus = 'STRONG PE';
          tradeStatusClass = 'status-strong-pe';
        } else if (quality >= 30) {
          finalTradeStatus = 'PE TRADE';
          tradeStatusClass = 'status-pe';
        } else if (quality >= 15) {
          finalTradeStatus = 'SMALL PE';
          tradeStatusClass = 'status-small-pe';
        }
      } else {
        triggers.push("PE > 65%", "Confidence > 60%", "Volume Surge > 20%", "CVD < 40%", "No Bullish Divergence");
      }
    }

    // Handle case where filters pass but Trade Quality is under 15
    if (reasons.length === 0 && quality < 15) {
      reasons.push(`Low Trade Quality (${quality}/100, needs >= 15)`);
      finalTradeStatus = 'NO TRADE';
      tradeStatusClass = 'status-no-trade';
      triggers.push("CE/PE split > 65%", "Confidence > 60%", "Trade Quality >= 15");
    }

    const allScores  = [...Object.values(signalMap).map(s => s.score), bull5m, bull15m, bull4h];
    const bullSigs   = allScores.filter(s => s > 0.55).length;
    const bearSigs   = allScores.filter(s => s < 0.45).length;
    const risk       = confidence > 72 ? 'Low' : confidence > 55 ? 'Medium' : 'High';
    const riskClass  = risk === 'Low' ? 'risk-low' : risk === 'Medium' ? 'risk-med' : 'risk-high';

    let signal = finalTradeStatus;
    let badgeClass = tradeStatusClass;

    const direction = cePercent >= 50 ? '▲ CE (Bullish)' : '▼ PE (Bearish)';
    const dirColor  = cePercent >= 50 ? '#10b981' : '#ef4444';

    const specialNotes = [];
    if (divAdj > 0)  specialNotes.push('📈 Bullish Divergence');
    if (divAdj < 0)  specialNotes.push('📉 Bearish Divergence');
    if (rsi < 25 && macdLine > 0 && volSurge > 1.5) specialNotes.push('🔄 Reversal Setup');
    if (curPrice < ma200 && volSurge > 1.5) specialNotes.push('💥 Breakdown Setup');
    if (futures.fundingRate < -0.0005 && obImbalance > 0.6) specialNotes.push('🚀 Short Squeeze');
    if (oiChangePct > 0.03 && curPrice > prevPrice) specialNotes.push('📊 OI+Price↑ Longs Building');
    if (newsSentiment.score > 0.7) specialNotes.push('📰 Strong Bullish News');
    if (newsSentiment.score < 0.3) specialNotes.push('📰 Strong Bearish News');

    const accuracy     = getAccuracy(symbol);
    const { data: sigAcc, needed: sigNeeded } = getSignalAccuracies(symbol);
    storePrediction(symbol, cePercent, curPrice, Object.fromEntries(Object.entries(signalMap).map(([k, s]) => [k, s.score])));

    return {
      symbol, cePercent, pePercent, confidence, risk, riskClass,
      signal, badgeClass, direction, dirColor, specialNotes,
      rsi: rsi.toFixed(1),
      macd: macdLine > 0 ? 'Bullish' : 'Bearish',
      macdColor: macdLine > 0 ? '#10b981' : '#ef4444',
      trend: ma50 > ma200 ? 'Bullish' : 'Bearish',
      trendColor: ma50 > ma200 ? '#10b981' : '#ef4444',
      trendStrength: `${((sTrend - 0.5) * 200).toFixed(1)}%`,
      volSurgePct: `${(volSurge * 100).toFixed(0)}%`,
      funding: `${(futures.fundingRate * 100).toFixed(4)}%`,
      fundingColor: futures.fundingRate < 0 ? '#10b981' : '#ef4444',
      obImb: `${(obImbalance * 100).toFixed(1)}%`,
      atrPct: `${atrPct.toFixed(2)}%`,
      regime,
      oiLabel,
      oiChangePct: `${(oiChangePct * 100).toFixed(2)}%`,
      cvdPct: `${(cvdScore * 100).toFixed(1)}%`,
      cvdColor: cvdScore > 0.55 ? '#10b981' : cvdScore < 0.45 ? '#ef4444' : '#94a3b8',
      accuracy,
      bullSigs, bearSigs, totalSigs: allScores.length,
      topDrivers,
      tradeQuality: quality,
      reasons,
      triggers,
      tradeStatus: finalTradeStatus,
      tradeStatusClass,
      newsScore: newsSentiment.score,
      newsLabel: newsSentiment.label,
      etfScore: etfData.score,
      etfLabel: etfData.label,
      tfScores: { '5m': (bull5m*100).toFixed(0), '15m': (bull15m*100).toFixed(0), '1h': (bull1hTF*100).toFixed(0), '4h': (bull4h*100).toFixed(0) },
    };
  } catch(e) {
    console.error(`Analysis failed for ${symbol}`, e);
    return null;
  }
}

function renderPredictionCard(r) {
  const regimeColors = { TRENDING:'#3b82f6', RANGING:'#f59e0b', BREAKOUT:'#ec4899', NEUTRAL:'#94a3b8' };
  const regimeColor  = regimeColors[r.regime] || '#94a3b8';

  const tfHtml = Object.entries(r.tfScores).map(([tf, pct]) => {
    const col = pct >= 55 ? '#10b981' : pct <= 45 ? '#ef4444' : '#94a3b8';
    return `<div class="pred-tf-item"><span class="pred-tf-label">${tf}</span><span class="pred-tf-val" style="color:${col}">${pct}%</span></div>`;
  }).join('');

  const driversHtml = r.topDrivers.map(d => {
    const icon  = d.bullish ? '+' : '−';
    const col   = d.bullish ? '#10b981' : '#ef4444';
    const intensity = d.impact > 0.05 ? 'Strong' : d.impact > 0.025 ? 'Moderate' : 'Weak';
    return `<div class="pred-driver"><span style="color:${col};font-weight:700">${icon}</span> ${d.label} <span class="pred-driver-int">${intensity}</span></div>`;
  }).join('');

  const specialHtml = r.specialNotes?.length
    ? `<div class="pred-special-notes">${r.specialNotes.map(n => `<span class="pred-note">${n}</span>`).join('')}</div>`
    : '';

  const newsColor = r.newsScore > 0.6 ? '#10b981' : r.newsScore < 0.4 ? '#ef4444' : '#94a3b8';
  const etfColor  = r.etfScore  > 0.6 ? '#10b981' : r.etfScore  < 0.4 ? '#ef4444' : '#94a3b8';

  const sigAccHtml = r.sigAcc
    ? `<div class="pred-sig-acc"><div class="pred-sig-acc-title">Signal Accuracy (${15 - (r.sigNeeded||0)}+ predictions)</div>
       <div class="pred-sig-acc-grid">${Object.entries(r.sigAcc).map(([k,v]) =>
         `<span class="pred-sig-acc-item"><span class="pred-sig-acc-key">${k}</span><span style="color:${v>=0.55?'#10b981':v<=0.45?'#ef4444':'#94a3b8'}">${Math.round(v*100)}%</span></span>`
       ).join('')}</div></div>`
    : r.sigNeeded
    ? `<div class="pred-accuracy-badge" style="background:rgba(0,0,0,0.2)">🎯 ${r.sigNeeded} more predictions until adaptive weights</div>`
    : '';

  const adaptBadge = r.isAdaptive
    ? `<span class="pred-adaptive-badge">⚡ Adaptive</span>` : '';

  const accuracyHtml = r.accuracy
    ? `<div class="pred-accuracy-badge">🎯 ${r.accuracy.pct}% historical accuracy (${r.accuracy.total} graded)</div>`
    : '';

  const reasonsHtml = r.reasons && r.reasons.length
    ? `<div class="pred-reasons-container">
         <div class="pred-reasons-title">❌ Rejection Reasons</div>
         <ul class="pred-reasons-list">
           ${r.reasons.map(reason => `<li>${reason}</li>`).join('')}
         </ul>
       </div>`
    : '';

  const triggersHtml = r.triggers && r.triggers.length
    ? `<div class="pred-triggers-container">
         <div class="pred-triggers-title">🎯 Next Trigger Targets</div>
         <div class="pred-triggers-list">
           ${r.triggers.map(t => `<span class="pred-trigger-pill">${t}</span>`).join('')}
         </div>
       </div>`
    : `<div class="pred-triggers-container" style="background:rgba(16,185,129,0.05); border-color:rgba(16,185,129,0.2)">
         <div class="pred-triggers-title" style="color:#6ee7b7">✨ Entry Filters Aligned</div>
         <div class="pred-triggers-list">
           <span class="pred-trigger-pill success">All Conditions Met</span>
         </div>
       </div>`;

  const card = document.createElement('div');
  card.className = 'pred-card';
  card.innerHTML = `
    <div class="pred-card-header">
      <span class="pred-symbol">${r.symbol} ${adaptBadge}</span>
      <div style="display:flex;gap:0.4rem;align-items:center">
        <span class="pred-regime-badge" style="border-color:${regimeColor};color:${regimeColor}">${r.regime}</span>
      </div>
    </div>

    <div class="prob-bar-container">
      <div class="prob-bar-labels">
        <span style="color:#10b981">▲ CE Probability</span>
        <span style="color:#ef4444">▼ PE Probability</span>
      </div>
      <div class="prob-bar-track">
        <div class="prob-bar-fill" style="width:0%" data-width="${r.cePercent}%"></div>
      </div>
      <div class="prob-bar-pcts">
        <span class="prob-ce">${r.cePercent}%</span>
        <span class="prob-pe">${r.pePercent}%</span>
      </div>
    </div>

    <!-- Trade Decision Bar -->
    <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.15); padding:0.4rem 0.5rem; border-radius:6px; border:1px solid var(--border-color)">
      <div>
        <div style="font-size:0.6rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.02em; margin-bottom:0.15rem">Trade Decision</div>
        <span class="pred-status-badge ${r.tradeStatusClass}">${r.tradeStatus}</span>
      </div>
      <div style="text-align:right">
        <div style="font-size:0.6rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.02em; margin-bottom:0.15rem">Trade Quality</div>
        <div style="font-weight:bold; font-size:0.9rem; font-family:'Space Mono', monospace; color:#fbbf24">${r.tradeQuality}/100</div>
      </div>
    </div>

    <div class="pred-tf-row">${tfHtml}</div>

    <div class="pred-drivers-section">
      <div class="pred-drivers-title">Top Drivers</div>
      <div class="pred-drivers-list">${driversHtml || '<span style="color:var(--text-secondary);font-size:0.82rem">No dominant signals</span>'}</div>
    </div>

    <div class="pred-indicators">
      <div class="pred-ind"><span class="pred-ind-label">Trend</span><span class="pred-ind-value" style="color:${r.trendColor}">${r.trend}</span></div>
      <div class="pred-ind"><span class="pred-ind-label">RSI</span><span class="pred-ind-value">${r.rsi}</span></div>
      <div class="pred-ind"><span class="pred-ind-label">MACD</span><span class="pred-ind-value" style="color:${r.macdColor}">${r.macd}</span></div>
      <div class="pred-ind"><span class="pred-ind-label">ATR%</span><span class="pred-ind-value">${r.atrPct}</span></div>
      <div class="pred-ind"><span class="pred-ind-label">Vol Surge</span><span class="pred-ind-value">${r.volSurgePct}</span></div>
      <div class="pred-ind"><span class="pred-ind-label">CVD</span><span class="pred-ind-value" style="color:${r.cvdColor}">${r.cvdPct} Buy</span></div>
      <div class="pred-ind"><span class="pred-ind-label">OI Δ</span><span class="pred-ind-value">${r.oiLabel} (${r.oiChangePct})</span></div>
      <div class="pred-ind"><span class="pred-ind-label">Order Book</span><span class="pred-ind-value">${r.obImb} Bid</span></div>
      <div class="pred-ind"><span class="pred-ind-label">Funding</span><span class="pred-ind-value" style="color:${r.fundingColor}">${r.funding}</span></div>
      <div class="pred-ind"><span class="pred-ind-label">News</span><span class="pred-ind-value" style="color:${newsColor}">${r.newsLabel}</span></div>
      <div class="pred-ind"><span class="pred-ind-label">ETF Flow</span><span class="pred-ind-value" style="color:${etfColor}">${r.etfLabel}</span></div>
    </div>

    ${specialHtml}
    ${reasonsHtml}
    ${triggersHtml}

    <div class="pred-agreement">
      <span>🟢 ${r.bullSigs} Bull</span>
      <span style="color:var(--text-secondary);font-size:0.75rem">of ${r.totalSigs} signals</span>
      <span>🔴 ${r.bearSigs} Bear</span>
    </div>

    ${sigAccHtml}
    ${accuracyHtml}

    <div class="pred-footer">
      <div>
        <div class="pred-confidence-label">Confidence</div>
        <div class="pred-confidence-value">${r.confidence}%</div>
        <span class="pred-risk ${r.riskClass}">${r.risk} Risk</span>
      </div>
      <div style="text-align:right">
        <div class="pred-direction-label">Expected Direction</div>
        <div class="pred-direction-value" style="color:${r.dirColor}">${r.direction}</div>
      </div>
    </div>
  `;
  requestAnimationFrame(() => {
    const fill = card.querySelector('.prob-bar-fill');
    if (fill) fill.style.width = fill.dataset.width;
  });
  return card;
}

const predCardsContainer = document.getElementById('predictions-cards');

if (btnRefreshPredictions) {
  btnRefreshPredictions.addEventListener('click', async () => {
    btnRefreshPredictions.disabled = true;
    predCardsContainer.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-secondary)">
        <div style="font-size:1.1rem;margin-bottom:0.5rem">⚡ Running multi-timeframe analysis...</div>
        <div style="font-size:0.85rem">5m · 15m · 1h · 4h · ATR · OI · CVD · Divergence for ${ASSETS_TO_PREDICT.join(', ')}</div>
      </div>`;

    const results = [];
    for (const sym of ASSETS_TO_PREDICT) {
      const res = await analyzeAsset(sym);
      if (res) results.push(res);
    }

    predCardsContainer.innerHTML = '';
    if (results.length === 0) {
      predCardsContainer.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-secondary)">Error fetching market data. Check connection.</div>`;
      btnRefreshPredictions.disabled = false;
      return;
    }

    results.sort((a, b) => b.cePercent - a.cePercent);
    results.forEach(r => predCardsContainer.appendChild(renderPredictionCard(r)));
    btnRefreshPredictions.disabled = false;
  });
}

// --- Init ---
initSampleOptionsData();
populateExpiryDropdown();

connectGlobalBtcWebSocket();
fetchGlobalBtcPriceREST();
fetchHistoricalData().then(() => {
  connectWebSocket();
});
fetchOptionsData();
setInterval(fetchOptionsData, 30000);
startActiveSymbolPolling();
startRealtimePnLRefresh();

updateMarketStats();
updateUI();

// ── Predictions settings inputs wiring ───────────────────────────
const cpKeyInput  = document.getElementById('cp-api-key');
const etfInput    = document.getElementById('etf-flow-input');
if (cpKeyInput) {
  cpKeyInput.value = localStorage.getItem('cryptopanic_key') || '';
  cpKeyInput.addEventListener('change', () => localStorage.setItem('cryptopanic_key', cpKeyInput.value.trim()));
}
if (etfInput) {
  etfInput.value = localStorage.getItem('etf_flow_usd') || '';
  etfInput.addEventListener('change', () => localStorage.setItem('etf_flow_usd', etfInput.value));
}

// ── Theme Toggle logic ───────────────────────────────────────────
const themeToggleBtn = document.getElementById('theme-toggle');
const currentTheme = localStorage.getItem('theme') || 'dark';
document.body.setAttribute('data-theme', currentTheme);
if (themeToggleBtn) {
  themeToggleBtn.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  themeToggleBtn.addEventListener('click', () => {
    const nextTheme = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', nextTheme);
    localStorage.setItem('theme', nextTheme);
    themeToggleBtn.textContent = nextTheme === 'dark' ? '☀️' : '🌙';
  });
}


