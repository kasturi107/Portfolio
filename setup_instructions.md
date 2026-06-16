# Dynamic DCA Backtester — Setup & Maintenance

The backtester uses a **hybrid price source**:

- **Bundled CSV** (`data/btc_daily_price.csv`) — Binance BTC/USDT daily close from
  CryptoDataDownload, covering **2017-08-17 → present**. This is the primary source and
  sidesteps CoinGecko's free-API 365-day history limit.
- **CoinGecko** (live) — only patches the recent gap between the CSV's last date and today
  (last 60 days endpoint). Non-fatal: if it fails, the tool runs on the CSV alone.
- **Coin Metrics** (live) — daily MVRV Z-Score risk metric (`CapMVRVCur`), full history
  back to 2012, free, no key.

## Running the tool

There is no build step, but the page **must be served over http** (not opened as a
`file://` URL), because the browser blocks local `fetch()` of the CSV under `file://`.

```bash
npx serve portfolio
# then open the printed URL and go to /dynamic-dca.html
```

Or use VS Code's **Live Server** extension on `portfolio/dynamic-dca.html`.

## Updating the historical price CSV

CryptoDataDownload refreshes the file roughly monthly, so the bundled CSV may lag a few
weeks behind today — CoinGecko covers that gap automatically. To refresh the bundled data:

1. Go to <https://www.cryptodatadownload.com/data/binance/>
2. Download **`Binance_BTCUSDT_d.csv`** (daily BTC/USDT OHLCV).
3. Replace `data/btc_daily_price.csv` with the downloaded file (keep the filename).
4. Refresh the browser. The tool **auto-detects the new date range** — no code changes needed.

### Expected CSV format

The parser is tolerant, but the file should look like this (a source-URL banner on line 1,
then a header row, then newest-first daily rows):

```
https://www.CryptoDataDownload.com
Unix,Date,Symbol,Open,High,Low,Close,Volume BTC,Volume USDT,tradecount
1781481600000,2026-06-15,BTCUSDT,65746.45,67292.15,65354.0,66328.74,...
...
```

The parser auto-locates the **Date** and **Close** columns by header name (it does not rely
on fixed positions) and normalizes the date to `YYYY-MM-DD` (it also handles
`YYYY-MM-DD HH:MM:SS UTC` and `M/D/YYYY` formats).

## Verifying it works

Open the browser console and run a backtest. You should see:

```
[DCA] BTC price CSV loaded: 3202 days (2017-08-17 to 2026-06-15)
[DCA] CoinGecko patch loaded: 1 days
[DCA] Risk data loaded: 5280 days
[DCA] Backtest date range: 2019-01-01 to 2024-12-31 — all dates have price + risk data ✓
```

(Exact day counts will grow over time.) If a date in your range has no price data, it is
logged as a `[DCA] No price data for … — skipping this period` warning and that period is
skipped — the tool never crashes on a gap.
