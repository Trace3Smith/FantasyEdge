// Shared server/browser ordering of source evidence, not a player valuation formula.
const band={HIGH:3,MEDIUM:2,LOW:1,UNKNOWN:0};
export function compareActions(a,b) {
  return ((band[b.urgency?.level]||0)-(band[a.urgency?.level]||0))
    || ((band[b.impact?.level]||0)-(band[a.impact?.level]||0))
    || ((band[b.confidence?.level]||0)-(band[a.confidence?.level]||0))
    || a.id.localeCompare(b.id);
}
