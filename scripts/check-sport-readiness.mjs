// Actual captured settings + explicit policy. This is NOT a provider transaction test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { leagueCapabilities, ENGINE_SPORTS, WRITE_SPORTS, AUTOPILOT_SPORTS } from '../leagueCapabilities.js';
import { parseScoringSettings } from '../api/_lib/espnScoring.js';
import { slotLabel } from '../api/_lib/espnFantasy.js';
for (const [sport,file] of [['nba','nba-117597-2027.json'],['nhl','nhl-28525-2027.json']]) {
  const fixture=JSON.parse(fs.readFileSync(new URL(`fixtures/league-settings/${file}`,import.meta.url)));
  assert.equal(fixture.settings.scoringSettings.scoringType,'ROTO');
  assert.deepEqual(leagueCapabilities(sport).capabilities,['READ_ONLY']);
  assert.ok(leagueCapabilities(sport).limitations.length);
  assert.equal(ENGINE_SPORTS.has(sport),false);
  assert.equal(WRITE_SPORTS.has(sport),false);
  assert.equal(AUTOPILOT_SPORTS.has(sport),false);
  const scoring=parseScoringSettings(fixture.settings.scoringSettings,sport);
  assert.equal(scoring.format,'category');
  assert.equal(scoring.weights,null);
  if(sport==='nhl') assert.deepEqual(scoring.cats,[], 'do not invent labels for provider hockey stats');
  // Captured fixtures do not prove roster slots, locks or transactions.
  assert.equal(fixture.settings.rosterSettings,undefined);
}
assert.equal(slotLabel(11,'nba'),'UTIL');
assert.equal(slotLabel(12,'nba'),'BE');
assert.equal(slotLabel(13,'nba'),'IR');
assert.equal(slotLabel(0,'nhl'),'0','hockey slot mapping remains explicitly unverified');
assert.deepEqual(leagueCapabilities('nba','yahoo').capabilities,[]);
assert.deepEqual(leagueCapabilities('pga').capabilities,[]);
for(const sport of ['mlb','wnba','nfl']) assert.ok(leagueCapabilities(sport).capabilities.includes('AUTOPILOT'));
console.log('PASS: NBA/NHL real-settings limits, unknown hockey mappings, and unchanged write/automation gates');
