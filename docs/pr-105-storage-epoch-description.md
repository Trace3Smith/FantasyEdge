# Secure ESPN compatibility foundation with an isolated storage epoch

**DRAFT — DO NOT MERGE OR DEPLOY. PR #104 remains blocked.**

Old plaintext-era requests can finish after cutover. This release prevents their Redis
writes from becoming trusted input by putting all new runtime state behind the fixed
`fe:e1:` namespace, with no legacy fallback. A preparing/sealed/active control gates
runtime access; operator-only bootstrap imports credentials as encrypted24-hour pending
candidates, never active connections. Authenticated confirmation performs fresh provider
validation and commits through lifecycle CAS. Autopilot and DNA require fresh opt-in;
manual/watch associations reset and bind to connection generation.

Existing AES-GCM v1 format, Premium/ownership checks, sport gates and revocation behavior
are preserved. Decision caches rebuild in the new epoch. Free mock allowance resumes
next UTC day after activation so cutover cannot grant a second allowance.

Validation: offline regressions, real disposable Redis lifecycle/activation race tests,
exact-source bootstrap/late-write rehearsal, future My Edge storage-contract rollback,
and intercepted desktop/mobile browser confirmation checks. See
`docs/espn-credential-compatibility.md` for commands and limitations.

No Production deployment, bootstrap/migration, WAF publication, key/token/environment
change, paid upgrade or PR merge is authorized. Isolated hosted certification and later
explicit cutover authorization are still required. Current104 has not yet adopted e1.
