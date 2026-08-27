// Snake/linear draft pick order — the single source for "who is on the clock" and "how many picks
// until a team's next turn". Shared by the draft board (fantasyedge-draft.html) and the server
// advice endpoint (api/draft/advise.js) so the two can't drift. Pure, browser- and node-importable.

// Which team slot (0-based) is on the clock at overall pick `i`. Linear keeps the same order every
// round; snake reverses it on even rounds. Mock drafts are always snake.
export function teamOnClock(i, teams, format = 'snake') {
  const round = Math.floor(i / teams) + 1, inRound = i % teams;
  if (format === 'linear') return inRound;
  return round % 2 === 1 ? inRound : teams - 1 - inRound; // snake
}

// picks between the current pick and this team's next turn (0 = on the clock now)
export function picksUntilNextTurn(pickIndex, teamIdx, teams, totalPicks, format = 'snake') {
  for (let i = pickIndex + 1; i < totalPicks; i++) {
    if (teamOnClock(i, teams, format) === teamIdx) return i - pickIndex - 1;
  }
  return Infinity; // no next turn — this is the final pick
}
