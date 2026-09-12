// Weighted ridge regression by normal equations — the one piece of linear algebra the game
// model needs, kept separate so it can be tested on its own and reused by both sports.
//
// WHY RIDGE AND NOT PLAIN LEAST SQUARES. The opponent-adjustment design matrix is rank
// deficient by construction: a team's offense rating and every opponent's defense rating enter
// as `mu + off_i - def_j`, so adding a constant to every offense and every defense leaves every
// prediction unchanged. Ordinary least squares has no unique answer there and a solver will
// either blow up or return whichever of the infinitely many solutions floating-point noise
// happens to land on. The ridge penalty removes that freedom by preferring the solution closest
// to zero, which also happens to be the one we want to report: ratings centred on league average.
//
// The penalty does a second job that matters more in practice. Early in a season a team has
// played two opponents, so its rating is estimated from a handful of games and the unpenalised
// estimate is wild. Ridge shrinks a thin sample toward average, which is the honest prior —
// exactly the behaviour teamReport.js gets from its MIN_GP crossover rule, but continuous.

// Solve (XᵀWX + λI')β = XᵀWy by Gauss-Jordan elimination with partial pivoting.
//
// `penalize` marks which columns the penalty applies to; an intercept must be excluded, or the
// fit is pulled toward predicting zero rather than toward predicting the mean.
export function ridgeSolve({ rows, y, weights, lambda, penalize }) {
  const n = rows.length;
  if (!n) throw new Error('ridgeSolve: no rows');
  const p = rows[0].length;
  const w = weights || new Array(n).fill(1);

  // Normal equations. Built directly rather than by forming X explicitly — the design matrices
  // here are sparse (three non-zero entries per row) but small enough that density costs nothing.
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    const wr = w[r];
    for (let i = 0; i < p; i++) {
      const xi = row[i];
      if (xi === 0) continue;
      b[i] += wr * xi * y[r];
      for (let j = i; j < p; j++) {
        const xj = row[j];
        if (xj === 0) continue;
        A[i][j] += wr * xi * xj;
      }
    }
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i]; // mirror
  for (let i = 0; i < p; i++) if (!penalize || penalize[i]) A[i][i] += lambda;

  // Gauss-Jordan with partial pivoting on the augmented [A | b].
  const M = Array.from({ length: p }, (_, i) => {
    const row = new Float64Array(p + 1);
    row.set(A[i]); row[p] = b[i];
    return row;
  });
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) continue; // singular even after the penalty — leave at 0
    if (piv !== c) { const t = M[piv]; M[piv] = M[c]; M[c] = t; }
    const d = M[c][c];
    for (let j = c; j <= p; j++) M[c][j] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = c; j <= p; j++) M[r][j] -= f * M[c][j];
    }
  }
  return Array.from({ length: p }, (_, i) => M[i][p]);
}

// Ordinary weighted least squares for a handful of columns — the margin fit, where the design
// is well conditioned and shrinkage would only bias the slope we are trying to measure.
export function olsSolve({ rows, y, weights }) {
  return ridgeSolve({ rows, y, weights, lambda: 1e-9, penalize: rows[0].map(() => false) });
}
