/* ============================================================
   Dynamic DCA Backtester — Bitcoin & Ethereum
   Pure vanilla JS. Fetches daily price history (bundled CSV +
   CoinGecko recent gap) and computes a daily risk score in [0,1]
   from the Coin Metrics free Community API via one of two pathways:
   a look-ahead-free MVRV Z-Score (BTC/ETH) or a power-law price
   residual (BTC only). Simulates a risk-weighted DCA strategy vs a flat
   DCA baseline and renders summary stats, three Chart.js charts
   and a table. A single asset selector toggles between BTC and ETH;
   each asset's data is fetched once and cached independently.
   ============================================================ */

/* ---------- Tiny DOM helper ---------- */
const $ = (id) => document.getElementById(id);

/* ---------- Per-asset configuration ---------- */
const ASSETS = {
  btc: {
    name: 'Bitcoin',
    symbol: 'BTC',
    glyph: '₿',
    priceCSV: './data/btc_daily_price.csv',
    coingeckoId: 'bitcoin',
    coinmetricsAsset: 'btc',
    defaultStartDate: '2019-01-01',
    color: '#f7931a', // BTC orange
    // Reference dates for the debug spot-check log (nearest-prior fill).
    spotChecks: ['2019-01-01', '2021-04-14', '2021-11-10', '2022-11-21', '2024-03-14', '2026-06-13'],
  },
  eth: {
    name: 'Ethereum',
    symbol: 'ETH',
    glyph: 'Ξ',
    priceCSV: './data/eth_daily_price.csv',
    coingeckoId: 'ethereum',
    coinmetricsAsset: 'eth',
    defaultStartDate: '2017-01-01',
    color: '#627eea', // ETH blue
    spotChecks: ['2018-12-15', '2021-05-12', '2021-11-10', '2022-06-18', '2024-03-12'],
  },
};

/* ---------- Default risk bands ---------- */
const DEFAULT_BANDS = [
  { from: 0.0, to: 0.1, mult: 4 },
  { from: 0.1, to: 0.2, mult: 3 },
  { from: 0.2, to: 0.3, mult: 2 },
  { from: 0.3, to: 0.5, mult: 1 },
  { from: 0.5, to: 1.0, mult: 0 },
];

/* ---------- Risk pathways ----------
   Two independent ways to produce R(t) ∈ [0,1]. The selected one drives riskForDate().
     mvrv     — MVRV Z-Score (on-chain, Coin Metrics), BTC + ETH
     powerlaw — power-law fair-value residual (price only), BTC only */
const PATHWAYS = {
  mvrv:     { label: 'MVRV Z-Score (on-chain, Coin Metrics)', short: 'MVRV Z-Score', assets: ['btc', 'eth'] },
  powerlaw: { label: 'Power-Law Residual (price, BTC only)',   short: 'Power-Law Residual', assets: ['btc'] },
};

/* ---------- MVRV pathway constants (spec §1) ----------
   Pass 2 normalizes each z_t against the running 2nd/98th percentiles of
   {z_s : s <= t}. No future data enters R_mvrv(t). The first MVRV_BURN_IN_DAYS
   observations have no risk value, and the backtest skips them. */
const MVRV_BURN_IN_DAYS = 365;
const MVRV_Q_LOW  = 0.02;  // q_low_t  = running 2nd percentile
const MVRV_Q_HIGH = 0.98;  // q_high_t = running 98th percentile

/* ---------- State ---------- */
let currentAsset = 'btc';              // active asset key ('btc' | 'eth')
let currentPathway = 'mvrv';           // active risk pathway ('mvrv' | 'powerlaw')
let userChangedStartDate = false;      // true once the user edits the start date manually
const priceCache = { btc: null, eth: null }; // { map, dates, … } price meta per asset
const riskCache  = { btc: null, eth: null }; // computeRisk() (MVRV pathway) output per asset
const plPriceCache = { btc: null };          // Coin Metrics PriceUSD points for the power-law fit
const plRiskCache = {};                      // computePowerLawRisk() output, keyed by fit mode + cutoff
const riskCsvData = { btc: null, eth: null }; // fallback: sorted array of { date, risk } per asset
const useCsvFallback = { btc: false, eth: false }; // true once a fallback CSV is loaded for that asset
const charts = {};                     // Chart.js instances, so we can destroy on rerun

/* ============================================================
   INITIALISATION
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  $('endDate').value = isoDate(new Date());          // default end = today
  $('startDate').value = ASSETS[currentAsset].defaultStartDate;
  renderBands(DEFAULT_BANDS);
  setupNav();
  setupEvents();
  updatePathwayControls(currentAsset);
  updateAssetLabels(currentAsset);
  runBacktest();                                     // auto-run for the default asset (BTC)
});

/* ---------- Mobile nav (mirrors the main site) ---------- */
function setupNav() {
  const hamburger = $('hamburger');
  const navLinks = $('navLinks');
  const navbar = $('navbar');
  if (hamburger) hamburger.addEventListener('click', () => navLinks.classList.toggle('open'));
  window.addEventListener('scroll', () => navbar.classList.toggle('scrolled', window.scrollY > 30));
}

function setupEvents() {
  $('addBandBtn').addEventListener('click', () => addBandRow({ from: 0, to: 0, mult: 1 }));
  $('runBtn').addEventListener('click', runBacktest);
  $('retryBtn').addEventListener('click', runBacktest);
  // Asset selector: switch on click.
  $('assetToggle').querySelectorAll('.asset-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchAsset(btn.dataset.asset));
  });
  // Track whether the user has manually overridden the start date.
  $('startDate').addEventListener('change', () => { userChangedStartDate = true; });
  // Risk pathway selector + power-law fit options: re-run with the new selection.
  $('riskPathway').addEventListener('change', () => {
    currentPathway = $('riskPathway').value;
    updatePathwayControls(currentAsset);
    updateAssetLabels(currentAsset);
    runBacktest();
  });
  $('plFitMode').addEventListener('change', () => { updatePathwayControls(currentAsset); runBacktest(); });
  $('plCutoff').addEventListener('change', runBacktest);
  // Fallback CSV controls (only visible after an auto-fetch failure)
  $('downloadTemplate').addEventListener('click', downloadTemplate);
  $('csvFile').addEventListener('change', handleCsvUpload);
}

/* ============================================================
   ASSET SWITCHING (STEP 4 + STEP 9)
   ============================================================ */
function switchAsset(assetKey) {
  if (!ASSETS[assetKey] || assetKey === currentAsset) return;
  currentAsset = assetKey;

  console.log('[DCA] Asset switched to:', assetKey);
  console.log('[DCA] Using cached data:', !!priceCache[assetKey]);

  updateAssetToggle(assetKey);
  updatePathwayControls(assetKey); // ETH: power-law disabled, falls back to MVRV
  // Only override the start date if the user hasn't set their own.
  if (!userChangedStartDate) $('startDate').value = ASSETS[assetKey].defaultStartDate;
  updateAssetLabels(assetKey);

  console.log('[DCA] Backtest re-run with', assetKey.toUpperCase());
  runBacktest(); // fetches if the cache is empty, otherwise reuses cached data
}

/** Highlight the active asset button. */
function updateAssetToggle(assetKey) {
  $('assetToggle').querySelectorAll('.asset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.asset === assetKey);
  });
}

/** Update all static UI labels that name the asset. */
function updateAssetLabels(assetKey) {
  const cfg = ASSETS[assetKey];
  $('introName').textContent = cfg.name;
  $('introSym1').textContent = cfg.symbol;
  $('introSym2').textContent = cfg.symbol;
  $('riskSource').textContent = currentPathway === 'powerlaw'
    ? `Risk source: Power-law residual (Coin Metrics price, normalized 0→1) — ${cfg.name}`
    : `Risk source: MVRV Z-Score (Coin Metrics, causal percentile-normalized 0→1) — ${cfg.name}`;
  $('statBtcLabel').textContent = `${cfg.symbol} Accumulated`;
  $('chartBtcTitle').textContent = `Cumulative ${cfg.symbol} Accumulated`;
}

/** Enable/disable pathway options for the asset (spec §3) and show power-law fit options. */
function updatePathwayControls(assetKey) {
  const sel = $('riskPathway');
  for (const opt of sel.options) opt.disabled = !PATHWAYS[opt.value].assets.includes(assetKey);
  if (!PATHWAYS[currentPathway].assets.includes(assetKey)) {
    currentPathway = 'mvrv';                       // e.g. ETH → power-law unavailable
    console.log(`[DCA] Power-law pathway unavailable for ${assetKey.toUpperCase()} — using MVRV Z-Score`);
  }
  sel.value = currentPathway;
  const isPl = currentPathway === 'powerlaw';
  $('plOptions').style.display = isPl ? 'block' : 'none';
  $('plCutoffField').style.display = isPl && $('plFitMode').value === 'frozen' ? 'block' : 'none';
}

/* ============================================================
   RISK BANDS TABLE
   ============================================================ */
function renderBands(bands) {
  $('bandsBody').innerHTML = '';
  bands.forEach(addBandRow);
}

function addBandRow(band) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="number" class="b-from" step="0.01" min="0" max="1" value="${band.from}" /></td>
    <td><input type="number" class="b-to"   step="0.01" min="0" max="1" value="${band.to}" /></td>
    <td><input type="number" class="b-mult" step="0.1"  min="0"        value="${band.mult}" /></td>
    <td><button class="band-remove" title="Remove">×</button></td>
  `;
  tr.querySelector('.band-remove').addEventListener('click', () => tr.remove());
  $('bandsBody').appendChild(tr);
}

/** Read the bands table into a sorted array of {from,to,mult}. */
function readBands() {
  const rows = [...$('bandsBody').querySelectorAll('tr')];
  const bands = rows.map((tr) => ({
    from: parseFloat(tr.querySelector('.b-from').value),
    to:   parseFloat(tr.querySelector('.b-to').value),
    mult: parseFloat(tr.querySelector('.b-mult').value),
  })).filter((b) => !isNaN(b.from) && !isNaN(b.to) && !isNaN(b.mult));
  bands.sort((a, b) => a.from - b.from);
  return bands;
}

/** Find the multiplier for a given risk value. Last band is inclusive of its upper bound. */
function multiplierForRisk(risk, bands) {
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const isLast = i === bands.length - 1;
    if (risk >= b.from && (risk < b.to || (isLast && risk <= b.to))) return b.mult;
  }
  return 0; // risk falls outside all bands → no investment
}

/* ============================================================
   STEP 1+2 — COIN METRICS FETCH & RISK COMPUTATION (per asset)
   ============================================================ */
async function fetchRiskData(assetKey, onProgress) {
  if (riskCache[assetKey]) return riskCache[assetKey]; // cached for this session

  const cfg = ASSETS[assetKey];
  onProgress && onProgress('Fetching on-chain data…');
  const today = isoDate(new Date());
  // CapMVRVCur (market cap ÷ realized cap) is available on the free Community tier;
  // the raw realized cap (CapRealUSD) is Pro-only, so we use the ready-made ratio.
  const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics` +
    `?assets=${cfg.coinmetricsAsset}&metrics=CapMVRVCur&frequency=1d` +
    `&start_time=2012-01-01&end_time=${today}&page_size=10000`;

  const rows = await fetchCoinMetricsRows(url, (n) => onProgress && onProgress(`Computing risk scores… (${n} days)`));
  riskCache[assetKey] = computeRisk(rows, assetKey);
  return riskCache[assetKey];
}

/** GET a Coin Metrics timeseries, following pagination. Throws on HTTP error or empty result. */
async function fetchCoinMetricsRows(url, onPage) {
  const rows = [];
  let page = 0;
  while (url && page < 20) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coin Metrics request failed (HTTP ${res.status}).`);
    const json = await res.json();
    if (Array.isArray(json.data)) rows.push(...json.data);
    url = json.next_page_url || null; // follow pagination if present
    page++;
    onPage && onPage(rows.length);
  }
  if (rows.length === 0) throw new Error('Coin Metrics returned no data.');
  return rows;
}

/**
 * MVRV pathway: compute R_mvrv(t) ∈ [0,1] with no look-ahead.
 * Pass 1: expanding-window z-score of CapMVRVCur (mean & sample std over days 0..t).
 * Pass 2: robust causal normalization against the running 2nd/98th percentiles of
 * the z-scores seen so far, with a MVRV_BURN_IN_DAYS burn-in where R is undefined.
 */
function computeRisk(rows, assetKey) {
  const cfg = ASSETS[assetKey];
  // Parse & keep only days where the MVRV ratio is present and valid.
  const pts = [];
  for (const r of rows) {
    const mvrv = parseFloat(r.CapMVRVCur);
    if (!r.time || isNaN(mvrv) || mvrv <= 0) continue;
    pts.push({ date: r.time.slice(0, 10), mvrv });
  }
  pts.sort((a, b) => a.date.localeCompare(b.date));

  // --- Pass 1: raw z-scores (expanding window) ---
  const zMap = {};    // date -> raw z-score
  const mvrvMap = {}; // date -> raw MVRV ratio
  const zScores = [];
  let sum = 0, sumSq = 0, n = 0;
  for (const p of pts) {
    sum += p.mvrv;
    sumSq += p.mvrv * p.mvrv;
    n++;
    const mean = sum / n;
    // Spec §1: sample variance s² = (Σx² − n·mean²) / (n − 1). Has less small-n bias in 2011–13.
    const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
    const std = Math.sqrt(variance);
    const z = std > 0 ? (p.mvrv - mean) / std : 0;  // z_t = (MVRV_t − mean_t) / s_t
    zMap[p.date] = z;
    mvrvMap[p.date] = p.mvrv;
    zScores.push(z);
  }
  const zMean = zScores.length ? zScores.reduce((a, b) => a + b, 0) / zScores.length : 0; // debug only

  // --- Pass 2: causal robust normalization (spec §1) ---
  // R_mvrv(t) = clamp((z_t − q_low_t) / (q_high_t − q_low_t), 0, 1), where q_low_t and q_high_t
  // are the 2nd/98th percentiles of {z_s : s ≤ t}. A sorted running array keeps this causal.
  const sortedZ = [];
  const map = {}, qLowMap = {}, qHighMap = {};
  for (let i = 0; i < pts.length; i++) {
    const d = pts[i].date;
    const z = zMap[d];
    insertSorted(sortedZ, z);                         // sortedZ = {z_s : s ≤ t}
    if (i < MVRV_BURN_IN_DAYS) continue;              // burn-in: R_mvrv(t) undefined, no entry
    const qLow  = quantileSorted(sortedZ, MVRV_Q_LOW);  // q_low_t
    const qHigh = quantileSorted(sortedZ, MVRV_Q_HIGH); // q_high_t
    const span = qHigh - qLow;
    map[d] = span > 0 ? clamp((z - qLow) / span, 0, 1) : 0;
    qLowMap[d] = qLow;
    qHighMap[d] = qHigh;
  }

  const dates = Object.keys(map).sort();
  const lastDate = dates.length ? dates[dates.length - 1] : null;

  // --- STEP 2: console debug output ---
  if (lastDate) {
    console.log(`=== ${cfg.symbol} MVRV Z-Score Debug ===`);
    console.log('Raw MVRV ratio today:', mvrvMap[lastDate]);
    console.log('Raw Z-Score today:', zMap[lastDate]);
    console.log(`Running Z-Score q${MVRV_Q_LOW * 100} today:`, qLowMap[lastDate]);
    console.log(`Running Z-Score q${MVRV_Q_HIGH * 100} today:`, qHighMap[lastDate]);
    console.log('Historical Z-Score mean:', zMean);
    console.log(`Burn-in: first ${MVRV_BURN_IN_DAYS} days skipped; risk defined from`, dates[0]);
    console.log('Normalized risk today [0–1]:', map[lastDate]);
    console.log('=========================');

    // Spot checks for known reference dates (forward-filled from nearest prior day; null = in burn-in).
    for (const d of cfg.spotChecks) {
      const z = forwardFill(zMap, Object.keys(zMap), d);
      const r = d < dates[0] ? null : forwardFill(map, dates, d);
      console.log(`Spot check ${d}: Z-Score =`, z, '| Risk =', r);
    }
  }

  return {
    pathway: 'mvrv',
    map, dates, zMap, mvrvMap, qLowMap, qHighMap,
    zMean,
    count: dates.length,
    firstDate: dates[0],
    lastDate,
    todayRisk: dates.length ? map[lastDate] : null,
    todayZ: dates.length ? zMap[lastDate] : null,
    todayMvrv: dates.length ? mvrvMap[lastDate] : null,
    rawLabel: dates.length ? `raw MVRV Z-Score: ${zMap[lastDate].toFixed(2)}` : '',
  };
}

/** Insert v into an ascending array in place (binary search + splice). */
function insertSorted(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, v);
}

/** p-quantile of an ascending array with linear interpolation (the usual "type 7" definition). */
function quantileSorted(arr, p) {
  if (arr.length === 0) return NaN;
  const h = (arr.length - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return arr[lo] + (h - lo) * (arr[hi] - arr[lo]);
}

/* ============================================================
   POWER-LAW RESIDUAL PATHWAY (spec §2) — BTC only, price only
   Inspired by public descriptions of power-law risk models such as
   panpanXBT's TradingView "BTC Risk Metric". That script is closed-source,
   so this is a reimplementation, not a bit-for-bit reproduction.
   ============================================================ */
const BTC_GENESIS_UTC = Date.UTC(2009, 0, 3); // 2009-01-03, Bitcoin genesis block
const PL_BURN_IN_DAYS = 365;  // minimum observations before the regression is used
const PL_PRICE_START  = '2010-07-18'; // first Coin Metrics PriceUSD day for BTC

// Diminishing-returns envelope A(τ) = C · τ^(−α) (spec §2), calibrated ONCE by
// calibratePowerLawEnvelope() on Coin Metrics BTC PriceUSD 2010-07-18 → 2026-11-17,
// using the expanding-window fit. These are fixed constants, so the calibration
// itself uses the full history. Re-run calibratePowerLawEnvelope() in the console to check them.
// Result: 15 yearly blocks; percentiles of ε/A are q02 ≈ −0.97 and q98 ≈ +1.03.
const PL_ENVELOPE_C     = 237.53; // C (natural-log price units · days^α)
const PL_ENVELOPE_ALPHA = 0.6531; // α (envelope decay exponent)

/** τ_t = days since 2009-01-03 (spec §2). */
function daysSinceGenesis(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - BTC_GENESIS_UTC) / 86400000;
}

/** Fetch (once per session) the daily BTC PriceUSD history used by the power-law fit. */
async function fetchPowerLawPrices(assetKey, onProgress) {
  if (plPriceCache[assetKey]) return plPriceCache[assetKey];
  const cfg = ASSETS[assetKey];
  onProgress && onProgress('Fetching price history for power-law fit…');
  // The bundled Binance CSV only starts in 2017, too late for a power-law fit,
  // so the fit uses Coin Metrics PriceUSD, which goes back to 2010.
  const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics` +
    `?assets=${cfg.coinmetricsAsset}&metrics=PriceUSD&frequency=1d` +
    `&start_time=${PL_PRICE_START}&end_time=${isoDate(new Date())}&page_size=10000`;
  const rows = await fetchCoinMetricsRows(url, (n) => onProgress && onProgress(`Computing power-law risk… (${n} days)`));
  const pts = [];
  for (const r of rows) {
    const price = parseFloat(r.PriceUSD);
    if (!r.time || isNaN(price) || price <= 0) continue;
    pts.push({ date: r.time.slice(0, 10), price });
  }
  pts.sort((a, b) => a.date.localeCompare(b.date));
  plPriceCache[assetKey] = pts;
  return pts;
}

/** Power-law risk for the given fit options, cached per (asset, mode, cutoff). */
async function fetchPowerLawRisk(assetKey, opts, onProgress) {
  if (!PATHWAYS.powerlaw.assets.includes(assetKey)) throw new Error('The power-law pathway is only available for BTC.');
  const key = `${assetKey}|${opts.mode}|${opts.mode === 'frozen' ? opts.cutoff : ''}`;
  if (plRiskCache[key]) return plRiskCache[key];
  const pts = await fetchPowerLawPrices(assetKey, onProgress);
  plRiskCache[key] = computePowerLawRisk(pts, assetKey, opts);
  return plRiskCache[key];
}

/**
 * Regression residuals, causal by construction (spec §2).
 *   log P_t ~ a_t + b_t · log τ_t, refit daily by OLS on {s ≤ t} (expanding), or on
 *   {s ≤ cutoff} for t > cutoff when opts.mode === 'frozen'.
 *   ε_t = log P_t − (a_t + b_t · log τ_t)
 * Natural logs throughout. Returns one row per day after the PL_BURN_IN_DAYS burn-in.
 */
function powerLawResiduals(pts, opts) {
  const frozen = opts.mode === 'frozen';
  const out = [];
  let n = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0; // running OLS sums
  for (const p of pts) {
    const tau = daysSinceGenesis(p.date);       // τ_t
    if (tau <= 0) continue;
    const x = Math.log(tau), y = Math.log(p.price);
    if (!frozen || p.date <= opts.cutoff) {     // frozen: stop adding points after the cutoff
      n++; Sx += x; Sy += y; Sxx += x * x; Sxy += x * y;
    }
    if (n < PL_BURN_IN_DAYS) continue;
    const den = n * Sxx - Sx * Sx;
    if (den <= 0) continue;
    const b = (n * Sxy - Sx * Sy) / den;        // b_t (OLS slope)
    const a = (Sy - b * Sx) / n;                // a_t (OLS intercept)
    const eps = y - (a + b * x);                // ε_t
    out.push({ date: p.date, tau, price: p.price, a, b, eps });
  }
  return out;
}

/** Envelope A(τ_t) = C · τ_t^(−α) (spec §2). */
function powerLawEnvelope(tau, C = PL_ENVELOPE_C, alpha = PL_ENVELOPE_ALPHA) {
  return C * Math.pow(tau, -alpha);
}

/**
 * One-off calibration of (C, α); the results are hard-coded in PL_ENVELOPE_*.
 *  1. α: split the residual history into consecutive 365-day blocks. For each block take
 *     the half-width h_k = (q98 − q02)/2 of ε. Fit ln h_k = ln C₀ − α · ln τ_k by OLS.
 *  2. C: with α fixed, let v = ε · τ^α. Choose u = 1/C to minimize the least-squares loss
 *     (u·q02(v) + 1)² + (u·q98(v) − 1)², so the 2nd/98th percentiles of ε/A land near −1/+1.
 *     Closed form: u = (q98 − q02) / (q02² + q98²).
 * Callable from the console: calibratePowerLawEnvelope(plPriceCache.btc).
 */
function calibratePowerLawEnvelope(pts, opts = { mode: 'expanding' }) {
  const res = powerLawResiduals(pts, opts);
  const xs = [], ys = [];
  for (let i = 0; i + 365 <= res.length; i += 365) {
    const block = res.slice(i, i + 365);
    const e = block.map((r) => r.eps).sort((p, q) => p - q);
    const h = (quantileSorted(e, 0.98) - quantileSorted(e, 0.02)) / 2;
    xs.push(Math.log(block[182].tau));
    ys.push(Math.log(h));
  }
  const m = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / m, my = ys.reduce((s, v) => s + v, 0) / m;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const alpha = -sxy / sxx;
  const v = res.map((r) => r.eps * Math.pow(r.tau, alpha)).sort((p, q) => p - q);
  const q02 = quantileSorted(v, 0.02), q98 = quantileSorted(v, 0.98);
  const C = (q02 * q02 + q98 * q98) / (q98 - q02);
  const scaled = v.map((x) => x / C);
  return { C, alpha, blocks: m, q02Scaled: quantileSorted(scaled, 0.02), q98Scaled: quantileSorted(scaled, 0.98) };
}

/** R_pl(t) = clamp(0.5 + 0.5 · ε_t / A(τ_t), 0, 1) (spec §2): ε=0 → 0.5, ε=±A → 1/0. */
function computePowerLawRisk(pts, assetKey, opts) {
  const cfg = ASSETS[assetKey];
  const res = powerLawResiduals(pts, opts);
  if (res.length === 0) {
    const err = new Error(opts.mode === 'frozen'
      ? `Power-law cutoff ${opts.cutoff} is too early: the fit needs ${PL_BURN_IN_DAYS} days of data from ${PL_PRICE_START}.`
      : 'Not enough price history for the power-law fit.');
    err.isConfig = true; // a settings problem, not a fetch failure: don't offer the CSV fallback
    throw err;
  }
  const map = {}, rowMap = {};
  for (const r of res) {
    r.A = powerLawEnvelope(r.tau);                       // A(τ_t)
    r.risk = clamp(0.5 + 0.5 * r.eps / r.A, 0, 1);       // R_pl(t)
    map[r.date] = r.risk;
    rowMap[r.date] = r;
  }
  const dates = res.map((r) => r.date);
  const lastDate = dates[dates.length - 1];
  const last = rowMap[lastDate];

  // --- Spec §5: power-law debug output (mirrors the MVRV block) ---
  console.log(`=== ${cfg.symbol} Power-Law Residual Debug (${opts.mode}${opts.mode === 'frozen' ? ' @ ' + opts.cutoff : ''}) ===`);
  console.log('Envelope constants: C =', PL_ENVELOPE_C, '| alpha =', PL_ENVELOPE_ALPHA);
  console.log('Date:', lastDate, '| price:', last.price, '| tau (days):', last.tau);
  console.log('a_t:', last.a);
  console.log('b_t:', last.b);
  console.log('eps_t:', last.eps);
  console.log('A(tau_t):', last.A);
  console.log('R_pl(t) [0–1]:', last.risk);
  console.log(`Burn-in: first ${PL_BURN_IN_DAYS} days skipped; risk defined from`, dates[0]);
  console.log('=========================');
  for (const d of cfg.spotChecks) {
    if (d < dates[0]) { console.log(`Spot check ${d}: in burn-in (no risk)`); continue; }
    const r = rowMap[dates[forwardFillIndex(dates, d)]];
    console.log(`Spot check ${d}: a_t =`, r.a, '| b_t =', r.b, '| eps_t =', r.eps, '| A =', r.A, '| R_pl =', r.risk);
  }

  return {
    pathway: 'powerlaw',
    map, dates, rowMap,
    count: dates.length,
    firstDate: dates[0],
    lastDate,
    todayRisk: last.risk,
    rawLabel: `power-law residual ε: ${last.eps.toFixed(3)} (envelope A: ${last.A.toFixed(3)})`,
  };
}

/* ============================================================
   RISK LOOKUP (STEP 3 — forward-fill from nearest prior date)
   ============================================================ */
/**
 * Risk for a DCA date from the selected pathway's output `rd` (MVRV or power-law).
 * Returns null before the pathway's first defined date (burn-in); simulate() skips those periods.
 */
function riskForDate(dateStr, assetKey, rd) {
  if (useCsvFallback[assetKey] && riskCsvData[assetKey] && riskCsvData[assetKey].length) {
    return forwardFillArr(riskCsvData[assetKey], dateStr);
  }
  if (!rd) return 0;
  if (rd.dates.length === 0 || dateStr < rd.dates[0]) return null; // burn-in: no risk value
  return forwardFill(rd.map, rd.dates, dateStr);
}

/** Largest date <= target via binary search; clamps to first entry if target precedes all. */
function forwardFill(map, dates, target) {
  if (dates.length === 0) return 0;
  return map[dates[forwardFillIndex(dates, target)]];
}

/** Index of the largest date <= target (0 if target precedes all). */
function forwardFillIndex(dates, target) {
  let lo = 0, hi = dates.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** Forward-fill over the sorted CSV array [{date,risk}]. */
function forwardFillArr(arr, target) {
  if (target < arr[0].date) return arr[0].risk;
  let lo = 0, hi = arr.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].date <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return arr[ans].risk;
}

/* ============================================================
   PRICE DATA — bundled CSV (history) + CoinGecko recent gap (per asset)
   ============================================================ */

/**
 * Load daily prices for an asset. The bulk of history comes from a bundled static
 * CSV (Binance daily close via CryptoDataDownload), which sidesteps CoinGecko's
 * 365-day free-API limit. Only the recent gap between the CSV's last date and
 * today is patched in from CoinGecko. Cached per asset for the session.
 */
async function loadPriceData(assetKey, onProgress) {
  if (priceCache[assetKey]) return priceCache[assetKey]; // already loaded this session

  const cfg = ASSETS[assetKey];
  onProgress && onProgress(`Loading ${cfg.symbol} price data (history)…`);
  let res;
  try {
    res = await fetch(cfg.priceCSV);
  } catch (e) {
    throw new Error('Could not load bundled price CSV. Serve the page over http (e.g. `npx serve portfolio`); file:// blocks local fetches.');
  }
  if (!res.ok) throw new Error(`Could not load ${cfg.priceCSV} (HTTP ${res.status}).`);

  const text = await res.text();
  const map = parsePriceCsv(text);
  let dates = Object.keys(map).sort();
  if (dates.length === 0) throw new Error('Bundled price CSV parsed to 0 rows — check the file format.');

  const csvFirst = dates[0];
  const csvLast = dates[dates.length - 1];
  const csvCount = dates.length;
  console.log(`[DCA] ${cfg.symbol} price CSV loaded: ${csvCount} days (${csvFirst} to ${csvLast})`);

  // Patch the recent gap (CSV end → today) from CoinGecko. Non-fatal on failure.
  let patchCount = 0;
  try {
    onProgress && onProgress('Fetching recent prices from CoinGecko…');
    patchCount = await patchRecentPrices(map, csvLast, cfg.coingeckoId);
  } catch (e) {
    console.warn(`[DCA] CoinGecko recent-price patch failed for ${cfg.symbol}, using CSV only:`, e.message);
  }
  console.log(`[DCA] CoinGecko patch loaded: ${patchCount} days (${cfg.symbol})`);

  dates = Object.keys(map).sort();
  priceCache[assetKey] = {
    map, dates, csvFirst, csvLast, csvCount, patchCount,
    lastDate: dates[dates.length - 1],
  };
  return priceCache[assetKey];
}

/** Parse a CryptoDataDownload-style CSV into { 'YYYY-MM-DD': close }. */
function parsePriceCsv(text) {
  const lines = text.split(/\r?\n/);
  // Locate the header row (the one naming the Close column); skip the source-URL banner.
  let headerIdx = lines.findIndex((l) => /(^|,)\s*close\s*(,|$)/i.test(l));
  if (headerIdx === -1) headerIdx = lines.findIndex((l) => /date/i.test(l) && /(open|close)/i.test(l));
  if (headerIdx === -1) throw new Error('Could not find a header row with a Close column.');

  const header = lines[headerIdx].split(',').map((h) => h.trim().toLowerCase());
  const dateCol = header.indexOf('date');
  const closeCol = header.indexOf('close');
  if (dateCol === -1 || closeCol === -1) throw new Error('CSV missing Date or Close column.');

  const map = {};
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length <= closeCol) continue;
    const date = normalizeDate(parts[dateCol]);
    const close = parseFloat(parts[closeCol]);
    if (!date || isNaN(close) || close <= 0) continue;
    map[date] = close; // one close per calendar day
  }
  return map;
}

/** Normalize assorted date strings to 'YYYY-MM-DD'. Handles ISO, "… UTC" and M/D/YYYY. */
function normalizeDate(raw) {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);          // 2019-01-01[ 00:00:00 UTC]
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);         // M/D/YYYY (US)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s);                                  // last-ditch fallback
  return isNaN(d) ? null : isoDate(d);
}

/** Fill dates after csvLast using CoinGecko's last-60-days endpoint. Returns # of days added. */
async function patchRecentPrices(map, csvLast, coingeckoId) {
  const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/market_chart?vs_currency=usd&days=60`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.prices)) throw new Error('no prices in response');

  // Reduce hourly points to one (latest) reading per day ≈ daily close.
  const daily = {};
  for (const [ts, price] of json.prices) daily[isoDate(new Date(ts))] = price;

  let added = 0;
  for (const d of Object.keys(daily)) {
    if (d > csvLast && !(d in map)) { map[d] = daily[d]; added++; } // CSV always wins for covered dates
  }
  return added;
}

/** Exact daily close for a date; tolerates tiny gaps (≤7d) but returns null for out-of-range dates. */
function priceForDate(target, priceMap) {
  const { map, dates } = priceMap;
  if (map[target]) return map[target];
  const tT = new Date(target).getTime();
  let best = null, bestDiff = Infinity;
  for (const d of dates) {
    const diff = Math.abs(new Date(d).getTime() - tT);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
    else if (diff > bestDiff) break;
  }
  // Only accept a neighbour within a week — keeps out-of-range dates from snapping to the CSV start.
  return best && bestDiff <= 7 * 86400000 ? map[best] : null;
}

/* ============================================================
   DCA PERIOD GENERATION
   ============================================================ */
function generatePeriods(startStr, endStr, freq) {
  const periods = [];
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  const cur = new Date(start);
  while (cur <= end) {
    periods.push(isoDate(cur));
    if (freq === 'daily') cur.setDate(cur.getDate() + 1);
    else if (freq === 'weekly') cur.setDate(cur.getDate() + 7);
    else cur.setMonth(cur.getMonth() + 1);
  }
  return periods;
}

/* ============================================================
   STEP 5 — RUN: fetch both sources in parallel, then simulate
   ============================================================ */
async function runBacktest() {
  const assetKey = currentAsset;
  const cfg = ASSETS[assetKey];

  // --- Validate inputs ---
  const startStr = $('startDate').value;
  const endStr = $('endDate').value;
  const base = parseFloat($('baseAmount').value);
  const freq = $('frequency').value;
  const bands = readBands();

  if (!startStr || !endStr) return showError('Please choose both a start and end date.');
  if (new Date(startStr) >= new Date(endStr)) return showError('Start date must be before end date.');
  if (isNaN(base) || base <= 0) return showError('Base investment must be a positive number.');
  if (bands.length === 0) return showError('Add at least one risk band.');

  // --- Risk pathway selection (spec §3) ---
  const pathway = PATHWAYS[currentPathway].assets.includes(assetKey) ? currentPathway : 'mvrv';
  const plOpts = { mode: $('plFitMode').value, cutoff: $('plCutoff').value };
  if (pathway === 'powerlaw' && plOpts.mode === 'frozen' && !plOpts.cutoff) {
    return showError('Choose a cutoff date for the frozen power-law fit.');
  }

  // --- Combined progress indicator ---
  const prog = { price: `Loading ${cfg.symbol} price data (history)…`, risk: 'Computing risk scores…' };
  const paint = () => { $('loaderText').innerHTML = `${prog.price}<br>${prog.risk}`; };
  showLoader();
  paint();

  // Load both sources in parallel; never reject so we can inspect each independently.
  const [priceRes, riskRes] = await Promise.all([
    loadPriceData(assetKey, (msg) => { prog.price = msg; paint(); })
      .then((p) => ({ ok: p })).catch((e) => ({ error: e })),
    (useCsvFallback[assetKey]
      ? Promise.resolve({ ok: null })  // already have a fallback CSV; skip the auto-fetch
      : (pathway === 'powerlaw'
          ? fetchPowerLawRisk(assetKey, plOpts, (msg) => { prog.risk = msg; paint(); })
          : fetchRiskData(assetKey, (msg) => { prog.risk = msg; paint(); }))
          .then((r) => ({ ok: r })).catch((e) => ({ error: e }))),
  ]);

  // --- Price errors are fatal ---
  if (priceRes.error) return showError(priceRes.error.message);
  const priceMeta = priceRes.ok;
  const priceMap = { map: priceMeta.map, dates: priceMeta.dates };

  // --- Risk errors: fall back to CSV upload ---
  if (riskRes.error) {
    if (riskRes.error.isConfig) return showError(riskRes.error.message);
    revealCsvFallback();
    return showError('Could not fetch risk data automatically. ' + riskRes.error.message +
      ' Upload a risk CSV in the fallback panel on the left, then re-run.');
  }

  // --- Console diagnostics ---
  const riskData = riskRes.ok; // selected pathway's output (null when the CSV fallback is in use)
  if (useCsvFallback[assetKey] && riskCsvData[assetKey]) {
    console.log(`[DCA] Risk data loaded: ${riskCsvData[assetKey].length} days (manual CSV fallback)`);
  } else {
    console.log(`[DCA] Risk data loaded: ${riskData.count} days (${cfg.symbol} ${PATHWAYS[pathway].short}, from ${riskData.firstDate})`);
    updateRiskCard(riskData);
  }

  // --- Simulate & render ---
  try {
    const sim = simulate({ startStr, endStr, base, freq, bands, priceMap, assetKey, riskData });
    if (sim.burnInDates.length > 0) {
      console.warn(`[DCA] ${sim.burnInDates.length} period(s) before ${riskData.firstDate} skipped (risk burn-in, no risk value)`);
    }
    if (sim.missingDates.length === 0) {
      console.log(`[DCA] Backtest date range: ${startStr} to ${endStr} — all dates have price + risk data ✓`);
    } else {
      console.warn(`[DCA] Backtest date range: ${startStr} to ${endStr} — ${sim.missingDates.length} period(s) skipped (missing price data)`);
    }
    renderResults(sim, assetKey);
  } catch (err) {
    showError(err.message || 'Simulation failed.');
  }
}

/* ============================================================
   BACKTEST ENGINE
   ============================================================ */
function simulate({ startStr, endStr, base, freq, bands, priceMap, assetKey, riskData }) {
  const periods = generatePeriods(startStr, endStr, freq);
  const series = [];
  const missingDates = [];
  const burnInDates = []; // periods before the pathway's first risk value
  let dynInvested = 0, dynBtc = 0;
  let flatInvested = 0, flatBtc = 0;

  for (const date of periods) {
    const price = priceForDate(date, priceMap);
    if (!price) {
      missingDates.push(date);
      console.warn(`[DCA] No price data for ${date} — skipping this period`);
      continue;
    }

    const risk = riskForDate(date, assetKey, riskData); // STEP 4: daily reading on the trigger date
    if (risk == null) { burnInDates.push(date); continue; } // burn-in: skip, don't invent a risk
    const mult = multiplierForRisk(risk, bands);

    const dynAmount = base * mult;
    dynInvested += dynAmount;
    dynBtc += dynAmount / price;
    flatInvested += base;
    flatBtc += base / price;

    series.push({
      date, price, risk, mult,
      dynAmount, flatAmount: base,
      dynInvested, flatInvested, dynBtc, flatBtc,
      dynValue: dynBtc * price, flatValue: flatBtc * price,
    });
  }

  if (series.length === 0) {
    throw new Error(burnInDates.length
      ? `All periods fall inside the risk burn-in window (risk starts ${riskData.firstDate}) — choose a later start date.`
      : 'No DCA periods produced any data — try a wider date range.');
  }

  const finalPrice = series[series.length - 1].price;
  const dynFinalValue = dynBtc * finalPrice;
  const flatFinalValue = flatBtc * finalPrice;

  const totals = {
    dynInvested, dynBtc, dynFinalValue,
    flatInvested, flatBtc, flatFinalValue,
    dynAvgCost: dynBtc > 0 ? dynInvested / dynBtc : 0,
    flatAvgCost: flatBtc > 0 ? flatInvested / flatBtc : 0,
    dynReturnPct: dynInvested > 0 ? ((dynFinalValue - dynInvested) / dynInvested) * 100 : 0,
    flatReturnPct: flatInvested > 0 ? ((flatFinalValue - flatInvested) / flatInvested) * 100 : 0,
    finalPrice,
  };
  return { series, totals, missingDates, burnInDates };
}

/* ============================================================
   RISK INFO CARD (STEP 6)
   ============================================================ */
function updateRiskCard(rd) {
  if (!rd || rd.todayRisk == null) return;
  const r = rd.todayRisk;
  const el = $('riskTodayValue');
  el.textContent = r.toFixed(2);
  el.style.color = riskColor(r, 1);
  $('riskBarMarker').style.left = (r * 100) + '%';
  $('riskTodayDate').textContent = `as of ${rd.lastDate}`;
  // STEP 3: show the pathway's raw input (MVRV Z-Score or power-law residual) for external cross-checks.
  $('riskTodayRaw').textContent = rd.rawLabel || '';
  $('riskInfoCard').style.display = 'block';
}

/* ============================================================
   RESULTS RENDERING
   ============================================================ */
function renderResults({ series, totals }, assetKey) {
  const cfg = ASSETS[assetKey];
  showResults();

  $('statInvested').textContent = fmtUsd(totals.dynInvested);
  $('statBtc').textContent = totals.dynBtc.toFixed(6) + ' ' + cfg.glyph;
  $('statValue').textContent = fmtUsd(totals.dynFinalValue);

  const dynVal = totals.dynReturnPct;
  $('statValueSub').textContent = `${dynVal >= 0 ? '+' : ''}${dynVal.toFixed(1)}% on invested`;

  const dynPerDollar = totals.dynInvested > 0 ? totals.dynFinalValue / totals.dynInvested : 0;
  const flatPerDollar = totals.flatInvested > 0 ? totals.flatFinalValue / totals.flatInvested : 0;
  const vsFlat = flatPerDollar > 0 ? ((dynPerDollar - flatPerDollar) / flatPerDollar) * 100 : 0;
  const vsEl = $('statVsFlat');
  vsEl.textContent = `${vsFlat >= 0 ? '+' : ''}${vsFlat.toFixed(1)}%`;
  vsEl.className = 'stat-value ' + (vsFlat >= 0 ? 'pos' : 'neg');

  renderComparisonTable(totals, assetKey);

  const labels = series.map((s) => s.date);
  renderValueChart(labels, series, assetKey);
  renderBtcChart(labels, series, assetKey);
  renderInvestChart(labels, series);
}

function renderComparisonTable(t, assetKey) {
  const cfg = ASSETS[assetKey];
  const betterValue = t.dynFinalValue >= t.flatFinalValue;
  const betterCost = t.dynAvgCost <= t.flatAvgCost;
  const betterReturn = t.dynReturnPct >= t.flatReturnPct;

  const g = ' ' + cfg.glyph;
  const rows = [
    ['Total invested', fmtUsd(t.dynInvested), fmtUsd(t.flatInvested), null],
    [`${cfg.symbol} accumulated`, t.dynBtc.toFixed(6) + g, t.flatBtc.toFixed(6) + g, t.dynBtc >= t.flatBtc ? 'dyn' : 'flat'],
    ['Final value', fmtUsd(t.dynFinalValue), fmtUsd(t.flatFinalValue), betterValue ? 'dyn' : 'flat'],
    [`Avg cost per ${cfg.symbol}`, fmtUsd(t.dynAvgCost), fmtUsd(t.flatAvgCost), betterCost ? 'dyn' : 'flat'],
    ['Return %', fmtPct(t.dynReturnPct), fmtPct(t.flatReturnPct), betterReturn ? 'dyn' : 'flat'],
  ];

  $('cmpBody').innerHTML = rows.map(([metric, dyn, flat, winner]) => `
    <tr>
      <td>${metric}</td>
      <td class="${winner === 'dyn' ? 'winner' : ''}">${dyn}</td>
      <td class="${winner === 'flat' ? 'winner' : ''}">${flat}</td>
    </tr>
  `).join('');
}

/* ---------- Chart colour helpers ---------- */
const CYAN = '#00d4ff';
const PURPLE = '#7c3aed';
const GRID = 'rgba(255,255,255,0.05)';
const TICK = '#8892a4';

/** Risk → colour (green = low risk, red = high risk). */
function riskColor(risk, alpha = 0.85) {
  const r = Math.max(0, Math.min(1, risk));
  let cr, cg;
  if (r < 0.5) { cr = Math.round(510 * r); cg = 200; }
  else { cr = 230; cg = Math.round(200 * (1 - (r - 0.5) * 2)); }
  return `rgba(${cr}, ${cg}, 60, ${alpha})`;
}

function baseScales(extra = {}) {
  return Object.assign({
    x: { ticks: { color: TICK, maxTicksLimit: 10, font: { family: 'Roboto Mono', size: 10 } }, grid: { color: GRID } },
    y: { ticks: { color: TICK, font: { family: 'Roboto Mono', size: 10 } }, grid: { color: GRID } },
  }, extra);
}

const legendCfg = { labels: { color: '#fff', font: { family: 'Inter', size: 11 }, usePointStyle: true, boxWidth: 8 } };

function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

function renderValueChart(labels, series, assetKey) {
  const cfg = ASSETS[assetKey];
  destroyChart('value');
  charts.value = new Chart($('chartValue'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Dynamic DCA value', data: series.map((s) => s.dynValue), borderColor: cfg.color, backgroundColor: 'rgba(0,212,255,0.08)', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true, yAxisID: 'y' },
        { label: 'Flat DCA value', data: series.map((s) => s.flatValue), borderColor: PURPLE, borderWidth: 2, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        { label: `${cfg.symbol} price (right)`, data: series.map((s) => s.price), borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, tension: 0.2, yAxisID: 'yPrice' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: legendCfg, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtUsd(c.parsed.y)}` } } },
      scales: baseScales({
        y: { position: 'left', ticks: { color: TICK, font: { family: 'Roboto Mono', size: 10 }, callback: (v) => '$' + abbr(v) }, grid: { color: GRID }, title: { display: true, text: 'Portfolio value (USD)', color: TICK, font: { size: 10 } } },
        yPrice: { position: 'right', ticks: { color: 'rgba(255,255,255,0.4)', font: { family: 'Roboto Mono', size: 10 }, callback: (v) => '$' + abbr(v) }, grid: { drawOnChartArea: false }, title: { display: true, text: `${cfg.symbol} price`, color: 'rgba(255,255,255,0.4)', font: { size: 10 } } },
      }),
    },
  });
}

function renderBtcChart(labels, series, assetKey) {
  const cfg = ASSETS[assetKey];
  destroyChart('btc');
  charts.btc = new Chart($('chartBtc'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: `Dynamic DCA ${cfg.symbol}`, data: series.map((s) => s.dynBtc), borderColor: cfg.color, backgroundColor: 'rgba(0,212,255,0.08)', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true },
        { label: `Flat DCA ${cfg.symbol}`, data: series.map((s) => s.flatBtc), borderColor: PURPLE, borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: legendCfg, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(6)} ${cfg.glyph}` } } },
      scales: baseScales({
        y: { ticks: { color: TICK, font: { family: 'Roboto Mono', size: 10 }, callback: (v) => v.toFixed(3) }, grid: { color: GRID }, title: { display: true, text: `Cumulative ${cfg.symbol}`, color: TICK, font: { size: 10 } } },
      }),
    },
  });
}

function renderInvestChart(labels, series) {
  destroyChart('invest');
  charts.invest = new Chart($('chartInvest'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Invested this period',
        data: series.map((s) => s.dynAmount),
        backgroundColor: series.map((s) => riskColor(s.risk)),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => {
          const s = series[c.dataIndex];
          return [`Invested: ${fmtUsd(s.dynAmount)}`, `Risk: ${s.risk.toFixed(2)}  ·  ${s.mult}× multiplier`];
        } } },
      },
      scales: baseScales({
        y: { ticks: { color: TICK, font: { family: 'Roboto Mono', size: 10 }, callback: (v) => '$' + abbr(v) }, grid: { color: GRID }, title: { display: true, text: 'USD invested', color: TICK, font: { size: 10 } }, beginAtZero: true },
      }),
    },
  });
}

/* ============================================================
   CSV FALLBACK (STEP 8) — per active asset
   ============================================================ */
function revealCsvFallback() {
  $('csvFallback').style.display = 'block';
}

function handleCsvUpload(e) {
  const file = e.target.files[0];
  const status = $('csvStatus');
  if (!file) return;
  const assetKey = currentAsset;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = parseRiskCsv(reader.result);
      if (data.length === 0) throw new Error('No valid rows found.');
      riskCsvData[assetKey] = data;
      useCsvFallback[assetKey] = true;
      status.textContent = `✓ Loaded ${data.length} risk points (${data[0].date} → ${data[data.length - 1].date}) for ${ASSETS[assetKey].symbol}. Re-run the backtest.`;
      status.className = 'csv-status ok';
    } catch (err) {
      riskCsvData[assetKey] = null; useCsvFallback[assetKey] = false;
      status.textContent = `✗ ${err.message}`;
      status.className = 'csv-status err';
    }
  };
  reader.onerror = () => { status.textContent = '✗ Could not read file.'; status.className = 'csv-status err'; };
  reader.readAsText(file);
}

function parseRiskCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 2) continue;
    const date = parts[0];
    const risk = parseFloat(parts[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(risk)) continue;
    out.push({ date, risk });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function downloadTemplate() {
  const sample = ['date,risk', '2019-01-01,0.15', '2019-01-08,0.22', '2019-01-15,0.31', '2019-01-22,0.28', '2019-01-29,0.35'].join('\n');
  const blob = new Blob([sample], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${currentAsset}-risk-template.csv`; a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   VIEW STATE HELPERS
   ============================================================ */
function showLoader() {
  $('resultsEmpty').style.display = 'none';
  $('errorBox').style.display = 'none';
  $('resultsContent').style.display = 'none';
  $('loaderText').textContent = 'Loading…';
  $('loader').style.display = 'flex';
}
function showError(msg) {
  $('resultsEmpty').style.display = 'none';
  $('loader').style.display = 'none';
  $('resultsContent').style.display = 'none';
  $('errorMsg').textContent = msg;
  $('errorBox').style.display = 'flex';
}
function showResults() {
  $('resultsEmpty').style.display = 'none';
  $('loader').style.display = 'none';
  $('errorBox').style.display = 'none';
  $('resultsContent').style.display = 'block';
}

/* ============================================================
   FORMATTING UTILITIES
   ============================================================ */
function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmtUsd(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
function abbr(v) {
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}
