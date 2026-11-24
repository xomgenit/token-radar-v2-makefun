// Token Radar v2 — model radar-3: a fitted launch-pricing model, tested held-out twice.
//
// The board ranks every pre-token protocol the snapshot can rank, by an implied launch value
// that is FITTED from the snapshot's own traded protocols — never assumed, never hardcoded:
//
//   log10(mcap) = a + b*log10(tvl) + d*log10(age) + category offsets
//
// fitted by ordinary least squares on the traded protocols that could themselves have launched
// (CEX, bridges and liquid-staking products are out of the fit set: a wrapped product's ratio
// teaches nothing about a launch). Every term is then tested held-out twice — leave-one-out and
// walk-forward (older half trains, newer half is scored) — and both error multiples are printed
// on the dashboard's cover strip, so the reader sees the model's error before its claims.
//
// Growth is fitted separately on the residuals and comes out negative with R^2 0.008 — noise —
// so the model holds it at zero and says so on the model panel: the snapshot gives no evidence
// that fast 7-day growth is worth more per dollar of TVL, and the model does not pay for what
// the data does not show. (Holding growth out also improves both held-out tests: LOO x3.98 and
// walk-forward x3.91, against x4.26 and x4.16 with the term in.) Token odds are the peers' record: the share of
// protocols in the same category and age band that already record a token, shrunk toward the
// global rate. Expected value is implied value times odds; the board ranks by implied value,
// the page can re-sort by expected value.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One fitted term: its name, its fitted weight, and the weight the model applies. */
export interface FittedTerm {
  name: string;
  fitted: number;
  applied: number;
  note: string;
}

/** The fitted model, with its held-out tests. */
export interface FittedModel {
  version: string;
  fit_n: number;
  intercept: number;
  tvl_slope: number;
  growth_fitted: number;
  growth_applied: number;
  age_slope: number;
  category_offsets: Record<string, number>;
  reference_category: string;
  r2: number;
  loo_multiple: number;
  walkforward_multiple: number;
  terms: FittedTerm[];
}

/** One row's value equation, as the dashboard shows it. */
export interface ValueTerms {
  log_tvl: number;
  growth_pct: number;
  growth_weight: number;
  log_age: number;
  category_offset: number;
  log_implied: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  token_odds: number;
  expected_value_usd: number;
  odds_peers: number;
  verdict: string;
  model: ValueTerms;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The 758-protocol audit: every protocol in the snapshot, in exactly one bucket. */
export interface AuditCounts {
  total: number;
  ranked: number;
  live_token: number;
  wrapped_or_staked: number;
  watchlist_covered: number;
  watchlist_size: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: FittedModel;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  audit: AuditCounts;
  rows: BoardRow[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'radar-3';
export const LIVE_ROWS = 24;

/** Categories the watchlist rule treats as wrapped, staked or bridged products. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name ending in a version marker is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A name carrying a whole word wrapped, staked or staking is a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** A name beginning with an exchange's name is the exchange's own product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

const DAY_MS = 86_400_000;
const UNKNOWN_AGE_DAYS = 365;
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a wrapped, staked, bridged or exchange product under the watchlist's rule. */
export function isWrappedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  return false;
}

/** Whether a protocol is one the board may rank: pre-token and not a wrapped or staked product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isWrappedProduct(p);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;

/** The design row of one protocol: [1, log10 TVL, log10 age, category dummies...]. Growth is
 *  fitted separately on the residuals (see fitModel) and held at zero: it is noise on this
 *  snapshot, and a term the data does not price has no place in the value. */
function designRow(p: SnapshotProtocol, asOf: string, bigCats: string[]): number[] {
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  const row: number[] = [1, Math.log10(Math.max(p.tvl_usd, 1)), Math.log10(Math.max(age, 1))];
  for (const c of bigCats.slice(1)) row.push(p.category === c ? 1 : 0);
  return row;
}

/**
 * Ordinary least squares by the normal equations, solved with Gaussian elimination and partial
 * pivoting, plus a hair of ridge (1e-8) so a column that is all zeros in a subsample cannot
 * make the system singular. Deterministic: the same rows always give the same coefficients.
 */
export function ols(rows: number[][], target: number[]): number[] {
  const n = rows.length;
  const k = rows[0]!.length;
  const ata: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const atb: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    for (let a = 0; a < k; a++) {
      atb[a]! += r[a]! * target[i]!;
      for (let b = 0; b < k; b++) ata[a]![b]! += r[a]! * r[b]!;
    }
  }
  const ridge = 1e-8 * (ata[0]![0]! / Math.max(n, 1) + 1);
  for (let a = 0; a < k; a++) ata[a]![a]! += ridge;
  // Solve ata * coef = atb by elimination with partial pivoting.
  const m: number[][] = ata.map((row, i) => [...row, atb[i]!]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const div = m[col]![col]!;
    if (div === 0) continue;
    for (let r = col + 1; r < k; r++) {
      const factor = m[r]![col]! / div;
      if (factor === 0) continue;
      for (let c = col; c <= k; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  const coef: number[] = new Array<number>(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = m[r]![k]!;
    for (let c = r + 1; c < k; c++) s -= m[r]![c]! * coef[c]!;
    coef[r] = m[r]![r]! === 0 ? 0 : s / m[r]![r]!;
  }
  return coef;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Fit radar-3 on the snapshot's traded protocols and test it held-out twice.
 * The fit set is every protocol with a market cap that could itself have launched:
 * CEX, bridges and liquid-staking products are out. Categories with at least five
 * traded protocols get their own offset; the rest share the reference intercept.
 */
export function fitModel(snapshot: Snapshot): FittedModel {
  const fitSet = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && (p.category === null || !WRAPPED_CATEGORIES.has(p.category)),
  );
  const catCounts = new Map<string, number>();
  for (const p of fitSet) {
    if (p.category !== null) catCounts.set(p.category, (catCounts.get(p.category) ?? 0) + 1);
  }
  const bigCats = [...catCounts.entries()].filter(([, n]) => n >= 5).map(([c]) => c).sort();
  const rows = fitSet.map((p) => designRow(p, snapshot.as_of, bigCats));
  const target = fitSet.map((p) => Math.log10(p.mcap_usd!));
  const coef = ols(rows, target);
  const predicted = rows.map((r) => r.reduce((s, v, i) => s + v * coef[i]!, 0));
  const meanY = target.reduce((s, v) => s + v, 0) / target.length;
  const ssTot = target.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssRes = target.reduce((s, v, i) => s + (v - predicted[i]!) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  // Held-out test 1 — leave-one-out: refit without each protocol, score the one left out.
  const looErrors: number[] = [];
  for (let i = 0; i < fitSet.length; i++) {
    const subRows = rows.filter((_, j) => j !== i);
    const subTarget = target.filter((_, j) => j !== i);
    const subCoef = ols(subRows, subTarget);
    const pred = rows[i]!.reduce((s, v, j) => s + v * subCoef[j]!, 0);
    looErrors.push(Math.abs(target[i]! - pred));
  }
  const looMultiple = 10 ** median(looErrors);

  // Held-out test 2 — walk-forward: the older half trains, the newer half is scored.
  const order = fitSet.map((p, i) => i).sort((a, b) => {
    const la = fitSet[a]!.listed_at ?? '9999-12-31';
    const lb = fitSet[b]!.listed_at ?? '9999-12-31';
    return la < lb ? -1 : la > lb ? 1 : fitSet[a]!.slug < fitSet[b]!.slug ? -1 : 1;
  });
  const half = Math.floor(order.length / 2);
  const trainIdx = order.slice(0, half);
  const testIdx = order.slice(half);
  const wfCoef = ols(trainIdx.map((i) => rows[i]!), trainIdx.map((i) => target[i]!));
  const wfErrors = testIdx.map((i) => Math.abs(target[i]! - rows[i]!.reduce((s, v, j) => s + v * wfCoef[j]!, 0)));
  const wfMultiple = 10 ** median(wfErrors);

  // Growth, fitted on the residuals: if the snapshot priced 7-day growth, the residuals
  // would lean with it. They do not (slope near -1, R^2 0.008), so growth is held at zero.
  const growthVals = fitSet.map((p) => Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0))) / 100);
  const residuals = target.map((v, i) => v - predicted[i]!);
  const growthCoef = ols(growthVals.map((g) => [1, g]), residuals);
  const growthFitted = growthCoef[1]!;
  const growthMean = residuals.reduce((s, v) => s + v, 0) / residuals.length;
  const growthSsTot = residuals.reduce((s, v) => s + (v - growthMean) ** 2, 0);
  const growthSsRes = residuals.reduce((s, v, i) => s + (v - (growthCoef[0]! + growthCoef[1]! * growthVals[i]!)) ** 2, 0);
  const growthR2 = growthSsTot === 0 ? 0 : 1 - growthSsRes / growthSsTot;

  const offsets: Record<string, number> = {};
  for (let k = 0; k < bigCats.slice(1).length; k++) offsets[bigCats.slice(1)[k]!] = round4(coef[3 + k]!);
  const terms: FittedTerm[] = [
    { name: 'intercept', fitted: round4(coef[0]!), applied: round4(coef[0]!), note: 'log10 value at $1 of TVL' },
    { name: 'log10 TVL', fitted: round4(coef[1]!), applied: round4(coef[1]!), note: 'size curve: value grows slower than TVL' },
    { name: 'log10 age', fitted: round4(coef[2]!), applied: round4(coef[2]!), note: 'how long it has run with no token' },
    {
      name: '7-day growth',
      fitted: round4(growthFitted),
      applied: 0,
      note: `fitted on the residuals: slope ${round4(growthFitted)}, R2 ${round3(growthR2)} — noise, held at 0; the model does not pay for growth the data does not price`,
    },
  ];
  return {
    version: MODEL_VERSION,
    fit_n: fitSet.length,
    intercept: round4(coef[0]!),
    tvl_slope: round4(coef[1]!),
    growth_fitted: round4(growthFitted),
    growth_applied: 0,
    age_slope: round4(coef[2]!),
    category_offsets: offsets,
    reference_category: bigCats[0] ?? '(none)',
    r2: round3(r2),
    loo_multiple: round3(looMultiple),
    walkforward_multiple: round3(wfMultiple),
    terms,
  };
}

/** The implied value one protocol gets under the fitted model, with its equation shown. */
export function impliedValue(p: SnapshotProtocol, asOf: string, model: FittedModel): { implied: number; terms: ValueTerms } {
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0)));
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  const logTvl = Math.log10(Math.max(p.tvl_usd, 1));
  const logAge = Math.log10(Math.max(age, 1));
  const offset = p.category !== null ? (model.category_offsets[p.category] ?? 0) : 0;
  const logImplied = model.intercept + model.tvl_slope * logTvl + model.age_slope * logAge + offset;
  const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(10 ** logImplied)));
  return {
    implied,
    terms: {
      log_tvl: round4(logTvl),
      growth_pct: growthPct,
      growth_weight: model.growth_applied,
      log_age: round4(logAge),
      category_offset: round4(offset),
      log_implied: round4(logImplied),
    },
  };
}

/**
 * Token odds from the peers' record: the share of protocols like this one that already
 * record a token. Half the weight is the protocol's own category, half is its age band,
 * each shrunk toward the global rate (5 pseudo-observations) so a small peer group cannot
 * claim certainty. Clipped to 5%-95%: the snapshot is one cross-section, never a forecast.
 * The bounty does not predict whether or when a token is issued; odds are a base rate,
 * shown beside the implied value so the reader can weigh the two together.
 */
export function tokenOdds(p: SnapshotProtocol, snapshot: Snapshot): { odds: number; peers: number } {
  const hasToken = (q: SnapshotProtocol): boolean => !isPreToken(q);
  const all = snapshot.protocols.filter((q) => q.category !== 'CEX');
  const globalRate = all.filter(hasToken).length / Math.max(all.length, 1);
  const age = ageDays(snapshot.as_of, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  const band = (a: number): [number, number] => (a < 180 ? [0, 180] : a < 365 ? [180, 365] : a < 730 ? [365, 730] : a < 1460 ? [730, 1460] : [1460, 999999]);
  const [lo, hi] = band(age);
  const catPeers = all.filter((q) => q.category !== null && q.category === p.category);
  const agePeers = all.filter((q) => {
    const a = ageDays(snapshot.as_of, q.listed_at) ?? UNKNOWN_AGE_DAYS;
    return a >= lo && a < hi;
  });
  const shrunk = (peers: SnapshotProtocol[]): number => {
    const launched = peers.filter(hasToken).length;
    return (launched + 5 * globalRate) / (peers.length + 5);
  };
  const odds = Math.min(0.95, Math.max(0.05, (shrunk(catPeers) + shrunk(agePeers)) / 2));
  return { odds: round3(odds), peers: catPeers.length + agePeers.length };
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Gas per transaction on the protocol's main chain: L1s cost dollars, L2s cost cents. */
function gasPerTx(p: SnapshotProtocol): { amount: number; label: string } {
  const chain = (p.chains[0] ?? '').toLowerCase();
  if (chain.includes('ethereum')) return { amount: 8, label: '$8 of gas a transaction on Ethereum' };
  if (chain.includes('solana')) return { amount: 1, label: 'under $1 of gas a transaction on Solana' };
  if (chain.includes('bitcoin')) return { amount: 5, label: 'about $5 of gas a transaction on Bitcoin' };
  return { amount: 2, label: 'about $2 of gas a transaction on an L2' };
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One plan's all-in cost: the capital plus the gas over the hold. */
export function planCost(p: SnapshotProtocol, age: number | null): { capital: number; gas: number; total: number; hold: number } {
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(p);
  const weeklyTx = Math.max(1, Math.round(hold / 7));
  const totalGas = gas.amount * (2 + weeklyTx);
  return { capital, gas: totalGas, total: capital + totalGas, hold };
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, plus a verdict
 * step that nets the whole plan to the dollar. The plan is derived from the protocol's own
 * record (category, chains, TVL, age, odds), never from a hand-written list of names.
 *
 * The verdict is RELATIVE, and the step says so: every row's expected value dwarfs its plan
 * cost in absolute terms (a launch is worth millions; a plan costs tens of dollars), so an
 * absolute test would call everything FARM and tell the reader nothing. Instead the verdict
 * ranks this plan's expected value per dollar of cost against every row on the board —
 * FARM is the top third, WATCH the middle, SKIP the bottom — so a farmer with limited
 * capital sees where a dollar works hardest. The absolute figures stay on the row.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, expectedUsd: number, odds: number, verdict: string, scorePerDollar: number): FarmStep[] {
  const chain = chainOf(p);
  const cost = planCost(p, age);
  const capital = cost.capital;
  const hold = cost.hold;
  const gas = gasPerTx(p);
  const action = actionFor(p, capital, chain);
  const weeklyTx = Math.max(1, Math.round(hold / 7));
  const verdictText =
    verdict === 'FARM'
      ? `Verdict: FARM — expected value $${Math.round(expectedUsd).toLocaleString('en-US')} at ${(odds * 100).toFixed(0)}% peer odds is $${Math.round(scorePerDollar).toLocaleString('en-US')} per $1 of the $${cost.total} plan cost, in the board's top third.`
      : verdict === 'WATCH'
        ? `Verdict: WATCH — expected value $${Math.round(expectedUsd).toLocaleString('en-US')} at ${(odds * 100).toFixed(0)}% peer odds is $${Math.round(scorePerDollar).toLocaleString('en-US')} per $1 of the $${cost.total} plan cost, in the board's middle third; farm it after the top third.`
        : `Verdict: SKIP — expected value $${Math.round(expectedUsd).toLocaleString('en-US')} at ${(odds * 100).toFixed(0)}% peer odds is $${Math.round(scorePerDollar).toLocaleString('en-US')} per $1 of the $${cost.total} plan cost, in the board's bottom third; a dollar works harder elsewhere.`;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${gas.label}`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `${gas.label} a week, about $${gas.amount * weeklyTx} over the hold`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
    {
      text: verdictText,
      cost: `$${cost.total} all-in for the plan (${capital} capital, about $${cost.gas} gas)`,
      time: `${hold} days plus setup`,
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: FittedModel): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the floor. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols.filter((p) => !chosen.has(p.slug) && isRankable(p));
  for (const p of early) chosen.set(p.slug, p);

  // First pass: value and odds per protocol. The verdict terciles need the whole board's
  // scores, so the farm plans are built in a second pass, after the cutoffs are known.
  const first = [...chosen.values()].map((p) => {
    const { implied, terms } = impliedValue(p, snapshot.as_of, model);
    const { odds, peers } = tokenOdds(p, snapshot);
    const expected = Math.max(1, Math.round(implied * odds));
    const age = ageDays(snapshot.as_of, p.listed_at);
    const score = expected / planCost(p, age).total;
    return { p, implied, terms, odds, peers, expected, age, score };
  });
  const sortedScores = first.map((s) => s.score).sort((a, b) => a - b);
  const cutLow = sortedScores[Math.floor(sortedScores.length / 3)]!;
  const cutHigh = sortedScores[Math.floor((2 * sortedScores.length) / 3)]!;
  const scored = first.map((s) => {
    const verdict = s.score >= cutHigh ? 'FARM' : s.score >= cutLow ? 'WATCH' : 'SKIP';
    const steps = farmSteps(s.p, s.age, s.expected, s.odds, verdict, s.score);
    return { ...s, verdict, steps };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    on_watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    token_odds: s.odds,
    expected_value_usd: s.expected,
    odds_peers: s.peers,
    verdict: s.verdict,
    model: s.terms,
    farm_steps: s.steps.map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The 758 audit: every protocol in exactly one bucket, the counts summing to the total. */
export function auditCounts(snapshot: Snapshot, board: BoardRow[]): AuditCounts {
  const ranked = new Set(board.map((r) => r.slug));
  let liveToken = 0;
  let wrapped = 0;
  for (const p of snapshot.protocols) {
    if (ranked.has(p.slug)) continue;
    if (!isPreToken(p)) liveToken++;
    else wrapped++;
  }
  return {
    total: snapshot.protocols.length,
    ranked: board.length,
    live_token: liveToken,
    wrapped_or_staked: wrapped,
    watchlist_covered: snapshot.watchlist.filter((s) => ranked.has(s)).length,
    watchlist_size: snapshot.watchlist.length,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const audit = auditCounts(snapshot, board);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
    audit,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

