 export default async function handler(req, res) {
  const sport = req.query.sport || 'mlb';
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    let url = '';
    
    if (sport === 'mlb') {
      // MLB official free API
      url = 'https://statsapi.mlb.com/api/v1/stats?stats=season&group=hitting&gameType=R&season=2025&limit=50&offset=0&sortStat=battingAverage&order=desc';
    } else if (sport === 'nba') {
      url = 'https://stats.nba.com/stats/leagueLeaders?LeagueID=00&PerMode=PerGame&Scope=S&Season=2024-25&SeasonType=Regular+Season&StatCategory=PTS';
    } else {
      res.json({ response: [], error: 'Sport not yet supported' });
      return;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      }
    });
    
    const data = await response.json();
    res.json(data);
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
