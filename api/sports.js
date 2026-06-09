const API_KEY = '97d07cd5f6bd23355fe2282806c2ab06';

const API_BASES = {
  mlb: 'https://v1.baseball.api-sports.io',
  nba: 'https://v1.basketball.api-sports.io',
  wnba: 'https://v1.basketball.api-sports.io',
  nhl: 'https://v1.hockey.api-sports.io',
  nfl: 'https://v1.american-football.api-sports.io',
};

const LEAGUE_IDS = { mlb:1, nba:12, wnba:8, nhl:57, nfl:1 };
const SEASONS = { mlb:2025, nba:'2024-2025', wnba:2025, nhl:'2024-2025', nfl:2025 };

export default async function handler(req, res) {
  const sport = req.query.sport || 'mlb';
  const base = API_BASES[sport];
  const league = LEAGUE_IDS[sport];
  const season = SEASONS[sport];

  try {
    const response = await fetch(
      `${base}/players/statistics?league=${league}&season=${season}`,
      { headers: { 'x-apisports-key': API_KEY } }
    );
    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
