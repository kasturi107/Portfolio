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

// Stores the 1D % change from the live quote fetch so the heatmap can reuse it
const dailyChanges = {};

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
      dailyChanges[stock.ticker] = data.dp;
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
   PERFORMANCE HEATMAP
   ============================================================ */
const HEATMAP_PERIODS = ['1D', '1W', 'YTD', '1Y', '5Y'];

// Returns a background color string reflecting the % magnitude
function heatColor(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return null;
  const t = Math.min(Math.abs(pct) / 40, 1); // saturate at ±40 %
  const a = (0.22 + t * 0.55).toFixed(2);
  if (pct >= 0) {
    const g = Math.round(80 + t * 155);
    const b = Math.round(30 + t * 45);
    return `rgba(0,${g},${b},${a})`;
  } else {
    const r = Math.round(90 + t * 145);
    return `rgba(${r},14,14,${a})`;
  }
}

// Find the closing price of the candle at or just before targetTs (Unix seconds)
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

function heatmapRow(item) {
  const cells = HEATMAP_PERIODS.map(p => {
    const pct = item.changes ? item.changes[p] : null;
    if (pct === null || pct === undefined || isNaN(pct)) {
      return `<td class="hm-cell hm-na">N/A</td>`;
    }
    const bg   = heatColor(pct);
    const sign = pct >= 0 ? '+' : '';
    const style = bg ? ` style="background:${bg}"` : '';
    return `<td class="hm-cell"${style}>${sign}${pct.toFixed(1)}%</td>`;
  }).join('');

  return `<tr>
    <td class="hm-ticker">${item.ticker}</td>
    <td class="hm-name">${item.name}</td>
    ${cells}
  </tr>`;
}

function renderHeatmap(results) {
  const table = document.getElementById('heatmapTable');
  const hdr   = HEATMAP_PERIODS.map(p => `<th>${p}</th>`).join('');
  let html    = `<thead><tr><th>Ticker</th><th>Name</th>${hdr}</tr></thead><tbody>`;

  const stocks  = results.filter(r => r.type === 'stock');
  const cryptos = results.filter(r => r.type === 'crypto');
  const cols    = 2 + HEATMAP_PERIODS.length;

  stocks.forEach(item => { html += heatmapRow(item); });
  html += `<tr class="hm-divider"><td colspan="${cols}">Cryptocurrencies</td></tr>`;
  cryptos.forEach(item => { html += heatmapRow(item); });

  html += '</tbody>';
  table.innerHTML = html;
}

function renderHeatmapSkeleton() {
  const table = document.getElementById('heatmapTable');
  const hdr   = HEATMAP_PERIODS.map(p => `<th>${p}</th>`).join('');
  const cols  = 2 + HEATMAP_PERIODS.length;
  let html    = `<thead><tr><th>Ticker</th><th>Name</th>${hdr}</tr></thead><tbody>`;

  const total = STOCKS.length + CRYPTOS.length;
  for (let i = 0; i < total; i++) {
    if (i === STOCKS.length) {
      html += `<tr class="hm-divider"><td colspan="${cols}">Cryptocurrencies</td></tr>`;
    }
    const skel = HEATMAP_PERIODS.map(() =>
      `<td class="hm-cell"><div class="skeleton" style="width:48px;height:0.8rem;margin:auto"></div></td>`
    ).join('');
    html += `<tr>
      <td class="hm-ticker"><div class="skeleton" style="width:42px;height:0.86rem;display:inline-block"></div></td>
      <td class="hm-name"><div class="skeleton" style="width:78px;height:0.76rem;display:inline-block"></div></td>
      ${skel}
    </tr>`;
  }
  html += '</tbody>';
  table.innerHTML = html;
}

async function loadHeatmap() {
  const btn     = document.getElementById('heatmapLoadBtn');
  const status  = document.getElementById('heatmapStatus');
  const wrapper = document.getElementById('heatmapWrapper');

  btn.disabled    = true;
  btn.textContent = '↻ Loading…';
  wrapper.style.display = 'block';
  renderHeatmapSkeleton();

  const now    = Math.floor(Date.now() / 1000);
  const ts1W   = now - 7   * 86400;
  const tsYTD  = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  const ts1Y   = now - 365 * 86400;
  const ts5Y   = now - 5 * 365 * 86400;

  const results   = [];
  let processed   = 0;
  const total     = STOCKS.length + CRYPTOS.length;

  for (const stock of STOCKS) {
    processed++;
    status.textContent = `Fetching ${stock.ticker}… (${processed}/${total})`;
    try {
      const from = ts5Y - 30 * 86400; // a small buffer before 5 Y mark
      const url  = `https://finnhub.io/api/v1/stock/candle?symbol=${stock.ticker}&resolution=W&from=${from}&to=${now}&token=${FINNHUB_API_KEY}`;
      const c    = await fetchCandles5Y(url);
      const last = c.c[c.c.length - 1];
      results.push({
        ...stock, type: 'stock', ok: true,
        changes: {
          '1D':  dailyChanges[stock.ticker] ?? null,
          '1W':  pctDiff(priceAtTs(c, ts1W),  last),
          'YTD': pctDiff(priceAtTs(c, tsYTD), last),
          '1Y':  pctDiff(priceAtTs(c, ts1Y),  last),
          '5Y':  pctDiff(priceAtTs(c, ts5Y),  last),
        },
      });
    } catch {
      results.push({ ...stock, type: 'stock', ok: false, changes: {} });
    }
    await new Promise(r => setTimeout(r, 250));
  }

  for (const crypto of CRYPTOS) {
    processed++;
    status.textContent = `Fetching ${crypto.ticker}… (${processed}/${total})`;
    try {
      const from = ts5Y - 30 * 86400;
      const url  = `https://finnhub.io/api/v1/crypto/candle?symbol=${crypto.symbol}&resolution=W&from=${from}&to=${now}&token=${FINNHUB_API_KEY}`;
      const c    = await fetchCandles5Y(url);
      const last = c.c[c.c.length - 1];
      results.push({
        ...crypto, type: 'crypto', ok: true,
        changes: {
          '1D':  dailyChanges[crypto.ticker] ?? null,
          '1W':  pctDiff(priceAtTs(c, ts1W),  last),
          'YTD': pctDiff(priceAtTs(c, tsYTD), last),
          '1Y':  pctDiff(priceAtTs(c, ts1Y),  last),
          '5Y':  pctDiff(priceAtTs(c, ts5Y),  last),
        },
      });
    } catch {
      results.push({ ...crypto, type: 'crypto', ok: false, changes: {} });
    }
    await new Promise(r => setTimeout(r, 250));
  }

  renderHeatmap(results);
  status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  btn.textContent = '↻ Refresh Heatmap';
  btn.disabled    = false;
}

document.getElementById('heatmapLoadBtn').addEventListener('click', () => {
  if (!document.getElementById('heatmapLoadBtn').disabled) loadHeatmap();
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
