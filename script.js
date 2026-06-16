/* ============================================================
   FINNHUB API KEY
   Get your free key at https://finnhub.io → Sign up → Dashboard
   Then replace the placeholder string below with your actual key.
   ============================================================ */
const FINNHUB_API_KEY = 'd7sb4shr01qorsvi2t70d7sb4shr01qorsvi2t7g';

/* ============================================================
   STOCKS CONFIGURATION
   Ticker symbols mapped to display names.
   ============================================================ */
const STOCKS = [
  { ticker: 'NVDA',  name: 'NVIDIA'          },
  { ticker: 'MSFT',  name: 'Microsoft'        },
  { ticker: 'AMZN',  name: 'Amazon'           },
  { ticker: 'UBER',  name: 'Uber'             },
  { ticker: 'NFLX',  name: 'Netflix'          },
  { ticker: 'MELI',  name: 'MercadoLibre'     },
  { ticker: 'PINS',  name: 'Pinterest'        },
  { ticker: 'TTD',   name: 'The Trade Desk'   },
  { ticker: 'GOOGL', name: 'Alphabet'         },
  { ticker: 'PYPL',  name: 'PayPal'           },
  { ticker: 'NVO',   name: 'Novo Nordisk'     },
  { ticker: 'LULU',  name: 'Lululemon'        },
  { ticker: 'META',  name: 'Meta'             },
  { ticker: 'NBIS',  name: 'NBIS'            },
  { ticker: 'CRWV',  name: 'CoreWeave'        },
  { ticker: 'IREN',  name: 'IREN Ltd'         },
];

// Crypto symbols use Finnhub's exchange:pair format
const CRYPTOS = [
  { ticker: 'BTC',  name: 'Bitcoin',  symbol: 'BINANCE:BTCUSDT' },
  { ticker: 'ETH',  name: 'Ethereum', symbol: 'BINANCE:ETHUSDT' },
  { ticker: 'SOL',  name: 'Solana',   symbol: 'BINANCE:SOLUSDT' },
  { ticker: 'SUI',  name: 'Sui',      symbol: 'BINANCE:SUIUSDT' },
  { ticker: 'AAVE', name: 'Aave',     symbol: 'BINANCE:AAVEUSDT'},
];

const REFRESH_SECONDS = 5 * 60; // auto-refresh every 5 minutes

// Populated by the quote fetch so the heatmap can reuse live 1D data and prices
const dailyChanges = {};
const liveQuotes   = {};

/* ============================================================
   NAVIGATION — scroll effect, hamburger, active link
   ============================================================ */
const navbar    = document.getElementById('navbar');
const hamburger = document.getElementById('hamburger');
const navLinks  = document.getElementById('navLinks');
const allLinks  = document.querySelectorAll('.nav-link');

window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 20);
  highlightActiveLink();
});

hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

// Close the mobile menu when any nav link is tapped
allLinks.forEach(link => {
  link.addEventListener('click', () => navLinks.classList.remove('open'));
});

// Highlight the nav link that corresponds to the currently visible section
function highlightActiveLink() {
  const sections = document.querySelectorAll('section[id]');
  let currentId = '';

  sections.forEach(sec => {
    if (window.scrollY >= sec.offsetTop - 120) {
      currentId = sec.id;
    }
  });

  allLinks.forEach(link => {
    const isActive = link.getAttribute('href') === `#${currentId}`;
    link.classList.toggle('active', isActive);
  });
}

/* ============================================================
   PARTICLE CANVAS — animated floating dots in the hero section
   ============================================================ */
const canvas = document.getElementById('particleCanvas');
const ctx    = canvas.getContext('2d');
let particles = [];

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

function buildParticles() {
  particles = [];
  // Density: one particle per ~14000 pixels of screen area
  const count = Math.floor((canvas.width * canvas.height) / 14000);
  for (let i = 0; i < count; i++) {
    particles.push({
      x:      Math.random() * canvas.width,
      y:      Math.random() * canvas.height,
      vx:     (Math.random() - 0.5) * 0.28,
      vy:     (Math.random() - 0.5) * 0.28,
      radius: Math.random() * 1.4 + 0.4,
      alpha:  Math.random() * 0.35 + 0.1,
    });
  }
}

function animateParticles() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  particles.forEach(p => {
    // Move
    p.x += p.vx;
    p.y += p.vy;

    // Wrap around edges so particles never disappear
    if (p.x < 0)             p.x = canvas.width;
    if (p.x > canvas.width)  p.x = 0;
    if (p.y < 0)             p.y = canvas.height;
    if (p.y > canvas.height) p.y = 0;

    // Draw dot
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0, 212, 255, ${p.alpha})`;
    ctx.fill();
  });

  // Draw faint connecting lines between nearby particles
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx   = particles[i].x - particles[j].x;
      const dy   = particles[i].y - particles[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 110) {
        ctx.beginPath();
        ctx.strokeStyle = `rgba(0, 212, 255, ${0.06 * (1 - dist / 110)})`;
        ctx.lineWidth   = 0.5;
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(particles[j].x, particles[j].y);
        ctx.stroke();
      }
    }
  }

  requestAnimationFrame(animateParticles);
}

resizeCanvas();
buildParticles();
animateParticles();

window.addEventListener('resize', () => {
  resizeCanvas();
  buildParticles();
});

/* ============================================================
   FADE-IN ON SCROLL — uses the Intersection Observer API
   Sections start invisible and slide up into view as you scroll
   ============================================================ */
const fadeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
    }
  });
}, { threshold: 0.08 });

document.querySelectorAll('.fade-in-section').forEach(el => {
  fadeObserver.observe(el);
});

/* ============================================================
   STOCK TRACKER
   ============================================================ */
const stocksGrid    = document.getElementById('stocksGrid');
const cryptosGrid   = document.getElementById('cryptosGrid');
const refreshBtn    = document.getElementById('refreshBtn');
const countdownEl   = document.getElementById('countdownTimer');

let countdownValue    = REFRESH_SECONDS;
let countdownInterval = null;

// Show skeleton loading cards while real data is being fetched
function renderSkeletons() {
  stocksGrid.innerHTML = STOCKS.map(() => `
    <div class="stock-card">
      <div class="skeleton skeleton-ticker"></div>
      <div class="skeleton skeleton-name"></div>
      <div class="skeleton skeleton-price"></div>
      <div class="skeleton skeleton-change"></div>
    </div>
  `).join('');
}

function renderCryptoSkeletons() {
  cryptosGrid.innerHTML = CRYPTOS.map(() => `
    <div class="stock-card">
      <div class="skeleton skeleton-ticker"></div>
      <div class="skeleton skeleton-name"></div>
      <div class="skeleton skeleton-price"></div>
      <div class="skeleton skeleton-change"></div>
    </div>
  `).join('');
}

// Format a number as a price string, e.g. 487.3 → "$487.30"
function formatPrice(value) {
  return '$' + value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Fetch one stock quote from Finnhub
async function fetchQuote(ticker) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Fetch all stocks one by one (sequential, not parallel) to respect API rate limits
async function fetchAllStocks() {
  refreshBtn.classList.add('loading');
  refreshBtn.textContent = '↻ Fetching…';
  renderSkeletons();

  const results = [];

  for (const stock of STOCKS) {
    try {
      const data = await fetchQuote(stock.ticker);
      dailyChanges[stock.ticker]  = data.dp;
      liveQuotes[stock.ticker]    = data.c;
      results.push({
        ...stock,
        price:   data.c,
        change:  data.dp,
        ok: true,
      });
    } catch {
      results.push({ ...stock, price: null, change: null, ok: false });
    }
    // 200 ms pause between requests — polite to the free-tier API
    await new Promise(r => setTimeout(r, 200));
  }

  renderCards(results);
  await loadAndRenderCryptos();
  refreshBtn.classList.remove('loading');
  refreshBtn.textContent = '↻ Refresh Now';
  resetCountdown();
}

// Build and inject the stock cards into the grid
function renderCards(results) {
  const timeStr = new Date().toLocaleTimeString();

  stocksGrid.innerHTML = results.map(stock => {
    // Card when data is unavailable
    if (!stock.ok || !stock.price) {
      return `
        <div class="stock-card">
          <div class="stock-ticker">${stock.ticker}</div>
          <div class="stock-name">${stock.name}</div>
          <div class="stock-price" style="color:var(--text-muted);font-size:0.85rem;">Data unavailable</div>
          <div class="stock-updated">—</div>
        </div>`;
    }

    const isUp       = stock.change >= 0;
    const direction  = isUp ? 'up' : 'down';
    const sign       = isUp ? '+' : '';
    const changeClass = isUp ? 'positive' : 'negative';

    return `
      <div class="stock-card ${direction}">
        <div class="stock-ticker">${stock.ticker}</div>
        <div class="stock-name">${stock.name}</div>
        <div class="stock-price">${formatPrice(stock.price)}</div>
        <div class="stock-change ${changeClass}">${sign}${stock.change.toFixed(2)}%</div>
        <div class="stock-updated">Updated ${timeStr}</div>
      </div>`;
  }).join('');
}

// Fetch and render all crypto cards sequentially
async function loadAndRenderCryptos() {
  renderCryptoSkeletons();
  const results = [];

  for (const crypto of CRYPTOS) {
    try {
      const data = await fetchQuote(crypto.symbol);
      dailyChanges[crypto.ticker] = data.dp;
      liveQuotes[crypto.ticker]   = data.c;
      results.push({ ...crypto, price: data.c, change: data.dp, ok: true });
    } catch {
      results.push({ ...crypto, price: null, change: null, ok: false });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  renderCryptoCards(results);
}

// Build and inject crypto cards — same card design, price shown without dollar sign prefix for coins
function renderCryptoCards(results) {
  const timeStr = new Date().toLocaleTimeString();

  cryptosGrid.innerHTML = results.map(crypto => {
    if (!crypto.ok || !crypto.price) {
      return `
        <div class="stock-card">
          <div class="stock-ticker">${crypto.ticker}</div>
          <div class="stock-name">${crypto.name}</div>
          <div class="stock-price" style="color:var(--text-muted);font-size:0.85rem;">Data unavailable</div>
          <div class="stock-updated">—</div>
        </div>`;
    }

    const isUp        = crypto.change >= 0;
    const direction   = isUp ? 'up' : 'down';
    const sign        = isUp ? '+' : '';
    const changeClass = isUp ? 'positive' : 'negative';

    return `
      <div class="stock-card ${direction}">
        <div class="stock-ticker">${crypto.ticker}</div>
        <div class="stock-name">${crypto.name}</div>
        <div class="stock-price">${formatPrice(crypto.price)}</div>
        <div class="stock-change ${changeClass}">${sign}${crypto.change.toFixed(2)}%</div>
        <div class="stock-updated">Updated ${timeStr}</div>
      </div>`;
  }).join('');
}

// Reset and start the 5-minute countdown timer
function resetCountdown() {
  clearInterval(countdownInterval);
  countdownValue = REFRESH_SECONDS;

  countdownInterval = setInterval(() => {
    countdownValue--;

    const mins = Math.floor(countdownValue / 60);
    const secs = String(countdownValue % 60).padStart(2, '0');
    countdownEl.textContent = `${mins}:${secs}`;

    if (countdownValue <= 0) {
      clearInterval(countdownInterval);
      fetchAllStocks();
    }
  }, 1000);
}

// Manual refresh — clicking the button resets everything
refreshBtn.addEventListener('click', () => {
  if (refreshBtn.classList.contains('loading')) return;
  clearInterval(countdownInterval);
  fetchAllStocks();
});

// Load stock data immediately when the page opens
fetchAllStocks();

/* ============================================================
   PERFORMANCE HEATMAP — TREEMAP
   ============================================================ */

// Approximate relative market caps for cell sizing
const MARKET_WEIGHTS = {
  MSFT: 3100, NVDA: 2900, AMZN: 2200, GOOGL: 2000,
  META: 1600, NFLX:  450, NVO:   380, UBER:   180,
  MELI:  120, PYPL:   65, TTD:    40, LULU:    35,
  PINS:   22, NBIS:   20, CRWV:   18, IREN:     3,
  BTC:  1900, ETH:   400, SOL:    90, SUI:     15, AAVE: 4,
};

let heatmapLoadedData    = null;
let currentHeatmapPeriod = '1D';

// 6-bucket color scale — matches the legend:
// < -20% | -20→-5% | -5→0% | 0→+5% | +5→+20% | > +20%
function tmColor(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '#0f0f1e';
  if (pct >  20) return '#09c463';  // > +20%  : vivid green
  if (pct >   5) return '#098c46';  // +5→+20% : medium green
  if (pct >   0) return '#0a5a2e';  // 0→+5%   : dark green
  if (pct >  -5) return '#5c1212';  // 0→-5%   : dark red
  if (pct > -20) return '#8c1818';  // -5→-20% : medium red
  return '#c41e1e';                  // < -20%  : vivid red
}

function priceAtTs(candles, targetTs) {
  let idx = -1;
  for (let i = 0; i < candles.t.length; i++) {
    if (candles.t[i] <= targetTs) idx = i;
    else break;
  }
  return idx >= 0 ? candles.c[idx] : null;
}

function pctDiff(from, to) {
  if (!from || !to || from === 0) return null;
  return ((to - from) / from) * 100;
}

async function fetchCandles5Y(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.s !== 'ok') throw new Error('no_data');
  return data;
}

function renderTreemap(data, period) {
  const container = document.getElementById('treemapContainer');
  const width  = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height || !data.length) return;

  const root = d3.hierarchy({ name: 'root', children: data })
    .sum(d => d.weight || 1)
    .sort((a, b) => b.value - a.value);

  d3.treemap()
    .size([width, height])
    .padding(2)
    .tile(d3.treemapSquarify.ratio(1.4))
    (root);

  container.innerHTML = '';

  root.leaves().forEach(leaf => {
    const d  = leaf.data;
    const pct = d.changes ? d.changes[period] : null;
    const w  = leaf.x1 - leaf.x0;
    const h  = leaf.y1 - leaf.y0;

    const cell = document.createElement('div');
    cell.className = 'tm-cell';
    cell.style.left       = leaf.x0 + 'px';
    cell.style.top        = leaf.y0 + 'px';
    cell.style.width      = w + 'px';
    cell.style.height     = h + 'px';
    cell.style.background = tmColor(pct);

    if (w > 28 && h > 20) {
      const tfs = Math.max(9, Math.min(w / (d.ticker.length * 0.62), h * 0.32, 30));
      const ifs = Math.max(7,  tfs * 0.6);

      let inner = `<div class="tm-ticker" style="font-size:${tfs.toFixed(1)}px">${d.ticker}</div>`;

      if (w > 52 && h > 52 && d.price) {
        inner += `<div class="tm-price" style="font-size:${ifs.toFixed(1)}px">${formatPrice(d.price)}</div>`;
      }
      if (h > 40 && w > 38 && pct !== null && !isNaN(pct)) {
        const sign = pct >= 0 ? '+' : '';
        inner += `<div class="tm-change" style="font-size:${ifs.toFixed(1)}px">${sign}${pct.toFixed(2)}%</div>`;
      }
      cell.innerHTML = inner;
    }

    container.appendChild(cell);
  });
}

async function loadHeatmap() {
  const btn       = document.getElementById('heatmapLoadBtn');
  const status    = document.getElementById('heatmapStatus');
  const tabs      = document.getElementById('periodTabs');
  const container = document.getElementById('treemapContainer');

  btn.disabled    = true;
  btn.textContent = '↻ Loading…';
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-family:\'Roboto Mono\',monospace;font-size:0.85rem;">Fetching data…</div>';

  const now    = Math.floor(Date.now() / 1000);
  // Finnhub free tier supports ~1 year of daily candles.
  // Use daily resolution with a 1Y window — reliable on the free tier.
  const from1Y = now - 370 * 86400;   // 1 year + 5-day buffer
  const ts1W   = now - 7   * 86400;
  const tsYTD  = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  const ts1Y   = now - 365 * 86400;
  const ts5Y   = now - 5 * 365 * 86400;

  // Helper: fetch candles and compute all period changes.
  // 1D always comes from the live quote stored in dailyChanges —
  // that way it never becomes null even if the candle call fails.
  async function buildChanges(url, ticker) {
    const out = { '1D': dailyChanges[ticker] ?? null, '1W': null, 'YTD': null, '1Y': null, '5Y': null };
    try {
      const c    = await fetchCandles5Y(url);
      const last = c.c[c.c.length - 1];
      out['1W']  = pctDiff(priceAtTs(c, ts1W),  last);
      out['YTD'] = pctDiff(priceAtTs(c, tsYTD), last);
      out['1Y']  = pctDiff(priceAtTs(c, ts1Y),  last);
      // Only populate 5Y if the dataset actually reaches back that far
      if (c.t[0] <= ts5Y) out['5Y'] = pctDiff(priceAtTs(c, ts5Y), last);
    } catch { /* candle unavailable — 1D still populated above */ }
    return out;
  }

  const results  = [];
  let processed  = 0;
  const total    = STOCKS.length + CRYPTOS.length;

  for (const stock of STOCKS) {
    processed++;
    status.textContent = `${stock.ticker} (${processed}/${total})`;
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${stock.ticker}&resolution=D&from=${from1Y}&to=${now}&token=${FINNHUB_API_KEY}`;
    const changes = await buildChanges(url, stock.ticker);
    results.push({
      ...stock, type: 'stock',
      price:   liveQuotes[stock.ticker] || null,
      weight:  MARKET_WEIGHTS[stock.ticker] || 10,
      changes,
    });
    await new Promise(r => setTimeout(r, 250));
  }

  for (const crypto of CRYPTOS) {
    processed++;
    status.textContent = `${crypto.ticker} (${processed}/${total})`;
    // Crypto candles (Binance) often have longer history — try 5Y first
    const from = Math.min(from1Y, ts5Y - 30 * 86400);
    const url  = `https://finnhub.io/api/v1/crypto/candle?symbol=${crypto.symbol}&resolution=W&from=${from}&to=${now}&token=${FINNHUB_API_KEY}`;
    const changes = await buildChanges(url, crypto.ticker);
    results.push({
      ...crypto, type: 'crypto',
      price:   liveQuotes[crypto.ticker] || null,
      weight:  MARKET_WEIGHTS[crypto.ticker] || 5,
      changes,
    });
    await new Promise(r => setTimeout(r, 250));
  }

  heatmapLoadedData = results;
  renderTreemap(results, currentHeatmapPeriod);

  tabs.style.display = 'flex';
  status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  btn.textContent    = '↻ Refresh';
  btn.disabled       = false;
}

// Period tab switching
document.getElementById('periodTabs').addEventListener('click', e => {
  const btn = e.target.closest('.period-btn');
  if (!btn || !heatmapLoadedData) return;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentHeatmapPeriod = btn.dataset.period;
  renderTreemap(heatmapLoadedData, currentHeatmapPeriod);
});

document.getElementById('heatmapLoadBtn').addEventListener('click', () => {
  if (!document.getElementById('heatmapLoadBtn').disabled) loadHeatmap();
});

// Re-render treemap on window resize
let _hmResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_hmResizeTimer);
  _hmResizeTimer = setTimeout(() => {
    if (heatmapLoadedData) renderTreemap(heatmapLoadedData, currentHeatmapPeriod);
  }, 180);
});

/* ============================================================
   CONTACT FORM
   ============================================================ */
document.getElementById('contactForm').addEventListener('submit', function (e) {
  e.preventDefault();
  // To send real emails: sign up at https://formspree.io, create a form,
  // then add  method="POST" action="https://formspree.io/f/YOUR_ID"
  // to the <form> tag in index.html and remove this JS listener.
  alert('Message received! To enable actual email delivery, connect this form to Formspree (see comment in index.html).');
  this.reset();
});
