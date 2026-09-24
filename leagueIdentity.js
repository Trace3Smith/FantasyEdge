// Provider-specific storage supplies the provider namespace. Never omit sport.
export const LEAGUE_SPORTS = new Set(['mlb', 'nfl', 'nba', 'nhl', 'wnba']);
export function leagueKeyOf(lg) {
  return `${lg.sport || 'mlb'}:${lg.season ?? lg.seasonId}:${lg.leagueId}:${lg.teamId ?? lg.team?.id}`;
}
export function parseLeagueKey(key, legacySport = 'mlb') {
  const parts = String(key).split(':');
  if (parts.length === 3) parts.unshift(legacySport);
  const [sport, season, leagueId, teamId] = parts;
  if (parts.length !== 4 || !LEAGUE_SPORTS.has(sport)
    || ![season, leagueId, teamId].every(x => /^\d+$/.test(x))) return null;
  return { sport, season: Number(season), leagueId, teamId: Number(teamId) };
}
export function qualifiedLeagueKey(key, legacySport = 'mlb') {
  const lg = parseLeagueKey(key, legacySport);
  return lg ? leagueKeyOf(lg) : key;
}
