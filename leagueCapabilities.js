// Explicit rollout policy shared by request and background paths. Dataset existence
// never grants write permission. Per-league scoring/lock validation remains required.
export const ENGINE_SPORTS = new Set(['mlb', 'wnba', 'nfl']);
export const WRITE_SPORTS = new Set(['mlb', 'wnba', 'nfl']);
export const AUTOPILOT_SPORTS = new Set(['mlb', 'wnba', 'nfl']);
const READ_SPORTS = new Set(['mlb', 'nfl', 'nba', 'nhl', 'wnba']);
export function leagueCapabilities(sport, platform = 'espn') {
  if (platform !== 'espn' || !READ_SPORTS.has(sport)) return { capabilities: [], limitations: ['provider_or_sport_not_supported'] };
  const capabilities = ['READ_ONLY'];
  if (ENGINE_SPORTS.has(sport)) capabilities.push('RECOMMENDATIONS', 'DRY_RUN');
  if (WRITE_SPORTS.has(sport)) capabilities.push('MANUAL_APPLY');
  if (AUTOPILOT_SPORTS.has(sport)) capabilities.push('AUTOPILOT');
  return { capabilities, limitations: sport === 'nhl' ? ['roster_slot_mapping_unverified', 'scoring_mapping_incomplete']
    : sport === 'nba' ? ['team_mapping_unverified', 'lineup_and_scoring_validation_pending'] : [] };
}
