 export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const sport = req.query.sport || 'mlb';

  try {
    let players = [];

    if (sport === 'mlb') {
      const r = await fetch(
        'https://statsapi.mlb.com/api/v1/stats?stats=season&group=hitting&gameType=R&season=2026&limit=500&sortStat=battingAverage&order=desc',
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const d = await r.json();
      const splits = d.stats?.[0]?.splits || [];
      players = splits.map((s, i) => ({
        rank: i + 1,
        name: s.player?.fullName || 'Unknown',
        emoji: '⚾',
        pos: s.position?.abbreviation || 'OF',
        team: s.team?.name || '—',
        s1: s.stat?.avg || '.000',
        s2: s.stat?.homeRuns ?? '0',
        s3: s.stat?.rbi ?? '0',
        s4: s.stat?.stolenBases ?? '0',
        s5: '—',
        s6: '—',
        trend: i < 10 ? 'up' : i > 35 ? 'down' : 'flat',
        trendVal: i < 10 ? '+' + (10 - i) : i > 35 ? '-' + (i - 35) : '0',
        own: Math.max(10, 99 - i * 2),
        tag: i < 5 ? 'fire' : i < 15 ? 'trending' : i > 40 ? 'slump' : null,
        rostered: false,
        cats: buildMLBCats(s.stat),
      }));
    }

    res.json({ players, sport });

  } catch (err) {
    res.status(500).json({ error: err.message, players: [] });
  }
}

function buildMLBCats(stat) {
  if (!stat) return [];
  const cats = [];
  if (parseFloat(stat.avg) > 0.260) cats.push('AVG');
  if (parseInt(stat.homeRuns) > 10) cats.push('HR');
  if (parseInt(stat.runs) > 20) cats.push('R');
  if (parseInt(stat.rbi) > 20) cats.push('RBI');
  if (parseInt(stat.stolenBases) > 5) cats.push('SB');
  if (parseFloat(stat.obp) > 0.320) cats.push('OBP');
  return cats;
}
