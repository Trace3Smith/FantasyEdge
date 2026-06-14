# Refreshing the prospect board snapshot

`api/_lib/prospect-board.json` is a committed snapshot of FanGraphs **THE BOARD**
(top prospects per org — hitters AND pitchers). The cron reads it because the live
FanGraphs fetch is Cloudflare-blocked from the server (see `api/_lib/fangraphs.js`).
The ranking list moves slowly — FanGraphs revises it a few times a year — so a
periodically-refreshed snapshot is the right granularity. Stats, synopsis, and
the promotion lifecycle stay fully dynamic; only the *ranking list* is snapshotted.

## Steps

1. Open the current board in a normal browser (it loads fine client-side;
   Cloudflare only challenges servers):
   `https://www.fangraphs.com/prospects/the-board/<SEASON>-prospect-list/summary`
2. Open DevTools → Console and paste the snippet below. It extracts the embedded
   `__NEXT_DATA__` board, splits it into hitters and pitchers, and downloads
   `prospect-board.json`.
3. Replace `api/_lib/prospect-board.json` with the downloaded file and commit.

The output shape matches what `fangraphs.js` produces from the live fetch, so the
downstream pipeline (crosswalk → MiLB join → synopsis) is unchanged.

## Console snippet

```js
(() => {
  const HITTER_POS = new Set(['C','1B','2B','3B','SS','LF','CF','RF','DH','UTIL','TWP']);
  const PITCHER_POS = new Set(['SP','SIRP','MIRP','RP','P']);
  const data = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
  const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
  let rows = null;
  for (const q of queries) {
    const arr = q?.state?.data;
    if (Array.isArray(arr) && arr.length > 100 && arr[0] && 'Org_Rank' in arr[0]) { rows = arr; break; }
  }
  if (!rows) throw new Error('prospect list not found in __NEXT_DATA__');
  const hitters = [];
  const pitchers = [];
  for (const r of rows) {
    const pos = r.Position || r.pos;
    const isHitter = HITTER_POS.has(pos);
    const isPitcher = !isHitter && PITCHER_POS.has(pos);
    if (!isHitter && !isPitcher) continue;
    const raw = r.PlayerId ?? r.UPID ?? r.ID;
    const numeric = /^\d+$/.test(String(raw)) ? String(raw) : null;
    (isHitter ? hitters : pitchers).push({
      fgId: numeric,
      fgIdRaw: String(raw),
      name: r.playerName || `${r.FirstName || ''} ${r.LastName || ''}`.trim(),
      org: r.Team || r.cORG || '—',
      pos,
      fv: r.FV_Current ?? (r.cFV != null ? Number(r.cFV) : null),
      orgRank: r.Org_Rank ?? r.Org_Rk ?? null,
      bats: r.Bats || null,
      throws: r.Throws || null,
      eta: r.ETA_Current ?? r.cETA ?? null,
    });
  }
  const season = Number((location.pathname.match(/(\d{4})-prospect-list/) || [])[1]) || new Date().getFullYear();
  const out = {
    _meta: { source: 'FanGraphs THE BOARD', season, capturedAt: new Date().toISOString().slice(0, 10), rows: hitters.length + pitchers.length },
    hitters,
    pitchers,
  };
  const blob = new Blob([JSON.stringify(out, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prospect-board.json';
  a.click();
  console.log(`Captured ${hitters.length} hitters + ${pitchers.length} pitchers from the ${season} board.`);
})();
```

> Note: the cron consumes each org's **top 10** per pool (`topHittersByOrg` /
> `topPitchersByOrg`), so capturing the full lists is fine — they're trimmed
> downstream. A pre-Phase-3 snapshot with no `pitchers` array still works; it just
> tracks no pitchers until you re-capture.
