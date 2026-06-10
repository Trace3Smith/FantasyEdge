exports.handler = async function(event) {
  const sport = event.queryStringParameters?.sport || 'mlb';

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

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
        s4: s.stat?.runs ?? '0',
        s5: s.stat?.stolenBases ?? '0',
        s6: s.stat?.obp ?? '—',
        statLabels: ['AVG', 'HR', 'RBI', 'R', 'SB', 'OBP'],
        trend: i < 10 ? 'up' : i > 35 ? 'down' : 'flat',
        trendVal: i < 10 ? '+' + (10 - i) : i > 35 ? '-' + (i - 35) : '0',
        own: Math.max(10, 99 - i * 2),
        tag: i < 5 ? 'fire' : i < 15 ? 'trending' : i > 40 ? 'slump' : null,
        rostered: false,
        cats: buildMLBCats(s.stat),
      }));

      // Pitchers: the MLB StatsAPI hitting endpoint returns no pitchers, so
      // fetch the pitching group separately and merge them in.
      const pr = await fetch(
        'https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&gameType=R&season=2026&limit=300&sortStat=strikeOuts&order=desc',
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const pd = await pr.json();
      const pSplits = pd.stats?.[0]?.splits || [];
      const base = players.length;
      const pitchers = pSplits.map((s, i) => {
        const stat = s.stat || {};
        const gs = parseInt(stat.gamesStarted) || 0;
        const gp = parseInt(stat.gamesPlayed) || 0;
        // The API only reports position "P"; classify SP vs RP from usage so
        // the SP/RP filters have something to match.
        const pos = gs >= Math.max(1, gp * 0.5) ? 'SP' : 'RP';
        return {
          rank: base + i + 1,
          name: s.player?.fullName || 'Unknown',
          emoji: '⚾',
          pos,
          team: s.team?.name || '—',
          // Pitcher rows repurpose the hitting stat columns; statLabels lets the
          // table show what each number actually is (header is hitter-oriented).
          s1: stat.strikeOuts ?? '0',
          s2: stat.wins ?? '0',
          s3: stat.saves ?? '0',
          s4: stat.holds ?? '0',
          s5: stat.era ?? '—',
          s6: stat.whip ?? '—',
          statLabels: ['K', 'W', 'SV', 'HD', 'ERA', 'WHIP'],
          trend: i < 10 ? 'up' : i > 35 ? 'down' : 'flat',
          trendVal: i < 10 ? '+' + (10 - i) : i > 35 ? '-' + (i - 35) : '0',
          own: Math.max(10, 99 - i * 2),
          tag: i < 5 ? 'fire' : i < 15 ? 'trending' : i > 40 ? 'slump' : null,
          rostered: false,
          cats: buildMLBPitchingCats(stat),
        };
      });
      players = players.concat(pitchers);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ players, sport }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, players: [] }),
    };
  }
};

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

function buildMLBPitchingCats(stat) {
  if (!stat) return [];
  const cats = [];
  if (parseFloat(stat.era) > 0 && parseFloat(stat.era) < 3.50) cats.push('ERA');
  if (parseInt(stat.strikeOuts) > 60) cats.push('K');
  if (parseFloat(stat.whip) > 0 && parseFloat(stat.whip) < 1.20) cats.push('WHIP');
  if (parseInt(stat.wins) > 5) cats.push('W');
  if (parseInt(stat.saves) > 8) cats.push('SV');
  if (parseInt(stat.holds) > 8) cats.push('HD');
  return cats;
}
