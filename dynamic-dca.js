/* ============================================================
   Dynamic DCA Backtester
   Pure vanilla JS. Fetches BTC price history from CoinGecko and
   computes a daily on-chain risk score (MVRV Z-Score, normalized
   to 0–1) from the Coin Metrics free Community API. Simulates a
   risk-weighted DCA strategy vs a flat DCA baseline and renders
   summary stats, three Chart.js charts and a table.
   ============================================================ */

/* ---------- Tiny DOM helper ---------- */
const $ = (id) => document.getElementById(id);

/* ---------- Default risk bands ---------- */
const DEFAULT_BANDS = [
  { from: 0.0, to: 0.1, mult: 4 },
  { from: 0.1, to: 0.2, mult: 3 },
  { from: 0.2, to: 0.3, mult: 2 },
  { from: 0.3, to: 0.5, mult: 1 },
  { from: 0.5, to: 1.0, mult: 0 },
];

/* ---------- MVRV Z-Score normalization ----------
   Normalization bounds are computed DYNAMICALLY from the actual fetched z-score
   series (min/max) inside computeRisk(), rather than hardcoded — see STEP 1. This
   keeps the [0,1] mapping calibrated to whatever range Coin Metrics returns. */

/* ---------- State ---------- */
let riskData = null;          // { map, dates, todayRisk, count, firstDate, lastDate } from Coin Metrics
let riskCsvData = null;       // fallback: sorted array of { date, risk }
let useCsvFallback = false;   // true once a fallback CSV is loaded
const charts = {};            // Chart.js instances, so we can destroy on rerun
// Price data lives on window.btcPriceCache ({date -> close}) + window.btcPriceMeta (diagnostics)

/* ============================================================
   INITIALISATION
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  $('endDate').value = isoDate(new Date());   // default end = today
  renderBands(DEFAULT_BANDS);
  setupNav();
  setupEvents();
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
  // Fallback CSV controls (only visible after an auto-fetch failure)
  $('downloadTemplate').addEventListener('click', downloadTemplate);
  $('csvFile').addEventListener('change', handleCsvUpload);
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
   STEP 1+2 — COIN METRICS FETCH & RISK COMPUTATION
   ============================================================ */
async function fetchRiskData(onProgress) {
  if (riskData) return riskData; // cached for this session

  onProgress && onProgress('Fetching on-chain data…');
  const today = isoDate(new Date());
  // CapMVRVCur (market cap ÷ realized cap) is available on the free Community tier;
  // the raw realized cap (CapRealUSD) is Pro-only, so we use the ready-made ratio.
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics` +
    `?assets=btc&metrics=CapMVRVCur&frequency=1d` +
    `&start_time=2012-01-01&end_time=${today}&page_size=10000`;

  const rows = [];
  let page = 0;
  while (url && page < 20) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coin Metrics request failed (HTTP ${res.status}).`);
    const json = await res.json();
    if (Array.isArray(json.data)) rows.push(...json.data);
    url = json.next_page_url || null; // follow pagination if present
    page++;
    onProgress && onProgress(`Computing risk scores… (${rows.length} days)`);
  }

  if (rows.length === 0) throw new Error('Coin Metrics returned no data.');
  riskData = computeRisk(rows);
  return riskData;
}

/**
 * Compute the normalized MVRV Z-Score risk series using an expanding window.
 * Pass 1: for each day i (chronological), use all data from day 0..i to derive
 * the running mean & population std of MVRV, then the z-score. Pass 2: normalize
 * each z-score to [0,1] using the ACTUAL historical min/max of the z-score series
 * (calibrated to the data Coin Metrics returns, not hardcoded bounds).
 */
function computeRisk(rows) {
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
    const variance = Math.max(0, sumSq / n - mean * mean); // population variance
    const std = Math.sqrt(variance);
    const z = std > 0 ? (p.mvrv - mean) / std : 0;
    zMap[p.date] = z;
    mvrvMap[p.date] = p.mvrv;
    zScores.push(z);
  }

  // --- Dynamic normalization bounds from the actual data (STEP 1) ---
  const zMin = zScores.length ? Math.min(...zScores) : 0;
  const zMax = zScores.length ? Math.max(...zScores) : 1;
  const zMean = zScores.length ? zScores.reduce((a, b) => a + b, 0) / zScores.length : 0;
  const span = zMax - zMin;

  // --- Pass 2: normalize to [0,1] ---
  const map = {};
  for (const p of pts) {
    map[p.date] = span > 0 ? clamp((zMap[p.date] - zMin) / span, 0, 1) : 0;
  }

  const dates = Object.keys(map).sort();
  const lastDate = dates.length ? dates[dates.length - 1] : null;

  // --- STEP 2: console debug output ---
  if (lastDate) {
    console.log('=== MVRV Z-Score Debug ===');
    console.log('Raw MVRV ratio today:', mvrvMap[lastDate]);
    console.log('Raw Z-Score today:', zMap[lastDate]);
    console.log('Historical Z-Score min:', zMin);
    console.log('Historical Z-Score max:', zMax);
    console.log('Historical Z-Score mean:', zMean);
    console.log('Normalized risk today [0–1]:', map[lastDate]);
    console.log('=========================');

    // Spot checks for known reference dates (forward-filled from nearest prior day).
    const refs = ['2019-01-01', '2021-04-14', '2021-11-10', '2022-11-21', '2024-03-14', '2026-06-13'];
    for (const d of refs) {
      const z = forwardFill(zMap, dates, d);
      const r = forwardFill(map, dates, d);
      console.log(`Spot check ${d}: Z-Score =`, z, '| Risk =', r);
    }
  }

  return {
    map, dates, zMap, mvrvMap,
    zMin, zMax, zMean,
    count: dates.length,
    firstDate: dates[0],
    lastDate,
    todayRisk: dates.length ? map[lastDate] : null,
    todayZ: dates.length ? zMap[lastDate] : null,
    todayMvrv: dates.length ? mvrvMap[lastDate] : null,
  };
}

/* ============================================================
   RISK LOOKUP (STEP 3 — forward-fill from nearest prior date)
   ============================================================ */
function riskForDate(dateStr) {
  if (useCsvFallback && riskCsvData && riskCsvData.length) {
    return forwardFillArr(riskCsvData, dateStr);
  }
  if (!riskData) return 0;
  return forwardFill(riskData.map, riskData.dates, dateStr);
}

/** Largest date <= target via binary search; clamps to first entry if target precedes all. */
function forwardFill(map, dates, target) {
  if (dates.length === 0) return 0;
  if (target < dates[0]) return map[dates[0]];
  let lo = 0, hi = dates.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return map[dates[ans]];
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
   PRICE DATA — bundled CSV (2017→present) + CoinGecko recent gap
   ============================================================ */

/**
 * Load BTC daily prices. The bulk of history comes from a bundled static CSV
 * (Binance daily close via CryptoDataDownload), which sidesteps CoinGecko's
 * 365-day free-API limit. Only the recent gap between the CSV's last date and
 * today is patched in from CoinGecko. Cached on window for the session.
 */
async function loadPriceData(onProgress) {
  if (window.btcPriceMeta) return window.btcPriceMeta; // already loaded this session

  onProgress && onProgress('Loading BTC price data (2017–present)…');
  let res;
  try {
    res = await fetch('./data/btc_daily_price.csv');
  } catch (e) {
    throw new Error('Could not load bundled price CSV. Serve the page over http (e.g. `npx serve portfolio`); file:// blocks local fetches.');
  }
  if (!res.ok) throw new Error(`Could not load data/btc_daily_price.csv (HTTP ${res.status}).`);

  const text = await res.text();
  const map = parsePriceCsv(text);
  let dates = Object.keys(map).sort();
  if (dates.length === 0) throw new Error('Bundled price CSV parsed to 0 rows — check the file format.');

  const csvFirst = dates[0];
  const csvLast = dates[dates.length - 1];
  const csvCount = dates.length;
  console.log(`[DCA] BTC price CSV loaded: ${csvCount} days (${csvFirst} to ${csvLast})`);

  // Patch the recent gap (CSV end → today) from CoinGecko. Non-fatal on failure.
  let patchCount = 0;
  try {
    onProgress && onProgress('Fetching recent prices from CoinGecko…');
    patchCount = await patchRecentPrices(map, csvLast);
  } catch (e) {
    console.warn('[DCA] CoinGecko recent-price patch failed, using CSV only:', e.message);
  }
  console.log(`[DCA] CoinGecko patch loaded: ${patchCount} days`);

  dates = Object.keys(map).sort();
  window.btcPriceCache = map;
  window.btcPriceMeta = {
    map, dates, csvFirst, csvLast, csvCount, patchCount,
    lastDate: dates[dates.length - 1],
  };
  return window.btcPriceMeta;
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
async function patchRecentPrices(map, csvLast) {
  const url = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=60';
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
  // Only accept a neighbour within a week — keeps pre-2017 dates from snapping to the CSV start.
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

  // --- Combined progress indicator ---
  const prog = { price: 'Loading BTC price data (2017–present)…', risk: 'Computing risk scores…' };
  const paint = () => { $('loaderText').innerHTML = `${prog.price}<br>${prog.risk}`; };
  showLoader();
  paint();

  // Load both sources in parallel; never reject so we can inspect each independently.
  const [priceRes, riskRes] = await Promise.all([
    loadPriceData((msg) => { prog.price = msg; paint(); })
      .then((p) => ({ ok: p })).catch((e) => ({ error: e })),
    (useCsvFallback
      ? Promise.resolve({ ok: null })  // already have a fallback CSV; skip the auto-fetch
      : fetchRiskData((msg) => { prog.risk = msg; paint(); })
          .then((r) => ({ ok: r })).catch((e) => ({ error: e }))),
  ]);

  // --- Price errors are fatal ---
  if (priceRes.error) return showError(priceRes.error.message);
  const priceMeta = priceRes.ok;
  const priceMap = { map: priceMeta.map, dates: priceMeta.dates };

  // --- Risk errors: fall back to CSV upload ---
  if (riskRes.error) {
    revealCsvFallback();
    return showError('Could not fetch risk data automatically. ' + riskRes.error.message +
      ' Upload a risk CSV in the fallback panel on the left, then re-run.');
  }

  // --- Console diagnostics ---
  if (useCsvFallback && riskCsvData) {
    console.log(`[DCA] Risk data loaded: ${riskCsvData.length} days (manual CSV fallback)`);
  } else {
    console.log(`[DCA] Risk data loaded: ${riskData.count} days`);
    updateRiskCard();
  }

  // --- Simulate & render ---
  try {
    const sim = simulate({ startStr, endStr, base, freq, bands, priceMap });
    if (sim.missingDates.length === 0) {
      console.log(`[DCA] Backtest date range: ${startStr} to ${endStr} — all dates have price + risk data ✓`);
    } else {
      console.warn(`[DCA] Backtest date range: ${startStr} to ${endStr} — ${sim.missingDates.length} period(s) skipped (missing price data)`);
    }
    renderResults(sim);
  } catch (err) {
    showError(err.message || 'Simulation failed.');
  }
}

/* ============================================================
   BACKTEST ENGINE
   ============================================================ */
function simulate({ startStr, endStr, base, freq, bands, priceMap }) {
  const periods = generatePeriods(startStr, endStr, freq);
  const series = [];
  const missingDates = [];
  let dynInvested = 0, dynBtc = 0;
  let flatInvested = 0, flatBtc = 0;

  for (const date of periods) {
    const price = priceForDate(date, priceMap);
    if (!price) {
      missingDates.push(date);
      console.warn(`[DCA] No price data for ${date} — skipping this period`);
      continue;
    }

    const risk = riskForDate(date);              // STEP 4: daily reading on the trigger date
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

  if (series.length === 0) throw new Error('No DCA periods produced any data — try a wider date range.');

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
  return { series, totals, missingDates };
}

/* ============================================================
   RISK INFO CARD (STEP 6)
   ============================================================ */
function updateRiskCard() {
  if (!riskData || riskData.todayRisk == null) return;
  const r = riskData.todayRisk;
  const el = $('riskTodayValue');
  el.textContent = r.toFixed(2);
  el.style.color = riskColor(r, 1);
  $('riskBarMarker').style.left = (r * 100) + '%';
  $('riskTodayDate').textContent = `as of ${riskData.lastDate}`;
  // STEP 3: show the raw MVRV Z-Score so it can be cross-checked externally.
  if (riskData.todayZ != null) {
    $('riskTodayRaw').textContent = `raw MVRV Z-Score: ${riskData.todayZ.toFixed(2)}`;
  }
  $('riskInfoCard').style.display = 'block';
}

/* ============================================================
   RESULTS RENDERING
   ============================================================ */
function renderResults({ series, totals }) {
  showResults();

  $('statInvested').textContent = fmtUsd(totals.dynInvested);
  $('statBtc').textContent = totals.dynBtc.toFixed(6) + ' ₿';
  $('statValue').textContent = fmtUsd(totals.dynFinalValue);

  const dynVal = totals.dynReturnPct;
  $('statValueSub').textContent = `${dynVal >= 0 ? '+' : ''}${dynVal.toFixed(1)}% on invested`;

  const dynPerDollar = totals.dynInvested > 0 ? totals.dynFinalValue / totals.dynInvested : 0;
  const flatPerDollar = totals.flatInvested > 0 ? totals.flatFinalValue / totals.flatInvested : 0;
  const vsFlat = flatPerDollar > 0 ? ((dynPerDollar - flatPerDollar) / flatPerDollar) * 100 : 0;
  const vsEl = $('statVsFlat');
  vsEl.textContent = `${vsFlat >= 0 ? '+' : ''}${vsFlat.toFixed(1)}%`;
  vsEl.className = 'stat-value ' + (vsFlat >= 0 ? 'pos' : 'neg');

  renderComparisonTable(totals);

  const labels = series.map((s) => s.date);
  renderValueChart(labels, series);
  renderBtcChart(labels, series);
  renderInvestChart(labels, series);
}

function renderComparisonTable(t) {
  const betterValue = t.dynFinalValue >= t.flatFinalValue;
  const betterCost = t.dynAvgCost <= t.flatAvgCost;
  const betterReturn = t.dynReturnPct >= t.flatReturnPct;

  const rows = [
    ['Total invested', fmtUsd(t.dynInvested), fmtUsd(t.flatInvested), null],
    ['BTC accumulated', t.dynBtc.toFixed(6) + ' ₿', t.flatBtc.toFixed(6) + ' ₿', t.dynBtc >= t.flatBtc ? 'dyn' : 'flat'],
    ['Final value', fmtUsd(t.dynFinalValue), fmtUsd(t.flatFinalValue), betterValue ? 'dyn' : 'flat'],
    ['Avg cost per BTC', fmtUsd(t.dynAvgCost), fmtUsd(t.flatAvgCost), betterCost ? 'dyn' : 'flat'],
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

function renderValueChart(labels, series) {
  destroyChart('value');
  charts.value = new Chart($('chartValue'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Dynamic DCA value', data: series.map((s) => s.dynValue), borderColor: CYAN, backgroundColor: 'rgba(0,212,255,0.08)', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true, yAxisID: 'y' },
        { label: 'Flat DCA value', data: series.map((s) => s.flatValue), borderColor: PURPLE, borderWidth: 2, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        { label: 'BTC price (right)', data: series.map((s) => s.price), borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, tension: 0.2, yAxisID: 'yPrice' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: legendCfg, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtUsd(c.parsed.y)}` } } },
      scales: baseScales({
        y: { position: 'left', ticks: { color: TICK, font: { family: 'Roboto Mono', size: 10 }, callback: (v) => '$' + abbr(v) }, grid: { color: GRID }, title: { display: true, text: 'Portfolio value (USD)', color: TICK, font: { size: 10 } } },
        yPrice: { position: 'right', ticks: { color: 'rgba(255,255,255,0.4)', font: { family: 'Roboto Mono', size: 10 }, callback: (v) => '$' + abbr(v) }, grid: { drawOnChartArea: false }, title: { display: true, text: 'BTC price', color: 'rgba(255,255,255,0.4)', font: { size: 10 } } },
      }),
    },
  });
}

function renderBtcChart(labels, series) {
  destroyChart('btc');
  charts.btc = new Chart($('chartBtc'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Dynamic DCA BTC', data: series.map((s) => s.dynBtc), borderColor: CYAN, backgroundColor: 'rgba(0,212,255,0.08)', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true },
        { label: 'Flat DCA BTC', data: series.map((s) => s.flatBtc), borderColor: PURPLE, borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: legendCfg, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(6)} ₿` } } },
      scales: baseScales({
        y: { ticks: { color: TICK, font: { family: 'Roboto Mono', size: 10 }, callback: (v) => v.toFixed(3) }, grid: { color: GRID }, title: { display: true, text: 'Cumulative BTC', color: TICK, font: { size: 10 } } },
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
   CSV FALLBACK (STEP 8)
   ============================================================ */
function revealCsvFallback() {
  $('csvFallback').style.display = 'block';
}

function handleCsvUpload(e) {
  const file = e.target.files[0];
  const status = $('csvStatus');
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = parseRiskCsv(reader.result);
      if (data.length === 0) throw new Error('No valid rows found.');
      riskCsvData = data;
      useCsvFallback = true;
      status.textContent = `✓ Loaded ${data.length} risk points (${data[0].date} → ${data[data.length - 1].date}). Re-run the backtest.`;
      status.className = 'csv-status ok';
    } catch (err) {
      riskCsvData = null; useCsvFallback = false;
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
  a.href = url; a.download = 'btc-risk-template.csv'; a.click();
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
