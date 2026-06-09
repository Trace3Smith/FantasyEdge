const API_KEY = '97d07cd5f6bd23355fe2282806c2ab06';

const API_BASES = {
  mlb:  'https://v1.baseball.api-sports.io',
  nba:  'https://v1.basketball.api-sports.io',
  wnba: 'https://v1.basketball.api-sports.io',
  nhl:  'https://v1.hockey.api-sports.io',
  nfl:  'https://v1.american-football.api-sports.io',
  pga:  'https://v1.golf.api-sports.io',
};

const LEAGUE_IDS = {
  mlb: 1, nba: 12, wnba: 8, nhl: 57, nfl: 1, pga: 1
};

const SEASONS = {
  mlb: 2025, nba: '2024-2025', wnba: 2025, nhl: '2024-2025', nfl: 2025, pga: 2025
};

exports.handler = async function(event) {
  const sport = event.queryStringParameters?.sport || 'mlb';

  if (!API_BASES[sport]) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid sport' })
    };
  }

  const base = API_BASES[sport];
  const league = LEAGUE_IDS[sport];
  const season = SEASONS[sport];
  const url = `${base}/players/statistics?league=${league}&season=${season}`;

  try {
    const res = await fetch(url, {
      headers: {
        'x-apisports-key': API_KEY,
        'x-rapidapi-host': base.replace('https://', ''),
      }
    });

    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
