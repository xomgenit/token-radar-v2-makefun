// Token Radar v2 — the page. Renders window.RADAR (written by main.ts from the same board
// that board.json holds, so the page and the scored board can never disagree), with sorting,
// filtering, a detail view per protocol, a live model sandbox, and the 758 audit.
// No network: every byte comes from data.js beside this page.

const R = window.RADAR;
const $ = (id) => document.getElementById(id);

/** $1.23B / $712M / $45K / $812. */
function money(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

/** +12.5% / -4.0% / —. */
function pct(n) {
  if (n === null || n === undefined) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

/** 731d / 1.2y / —. */
function age(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 365) return (n / 365).toFixed(1) + 'y';
  return n + 'd';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* The integrity strip: the dashboard answers its own checks on the cover. */
function renderKpi() {
  const m = R.model;
  const a = R.audit;
  const stats = [
    [`${a.watchlist_covered}/${a.watchlist_size}`, 'watchlist covered', true],
    [`${R.board_size}`, `board rows (${R.early_size} early)`, false],
    [money(R.total_implied_usd), 'total implied value', false],
    [`x${m.loo_multiple}`, 'leave-one-out error', false],
    [`x${m.walkforward_multiple}`, 'walk-forward error', false],
    [`${a.ranked + a.live_token + a.wrapped_or_staked}/${a.total}`, 'protocols accounted for', true],
  ];
  $('kpi').innerHTML = stats.map(([v, label, ok]) =>
    `<div class="stat${ok ? ' ok' : ''}"><b>${v}</b><span>${label}</span></div>`).join('');
  $('asof').textContent = 'as of ' + R.as_of;
}

/* Sandbox state: multipliers on the fitted terms. Null means the fitted model. */
let sandbox = null;

/** A row's implied value under the current sandbox (or the fitted model). */
function shownImplied(row) {
  if (!sandbox) return row.implied_value_usd;
  const m = R.model;
  const t = row.model;
  const logV = m.intercept + m.tvl_slope * sandbox.tvl * t.log_tvl
    + sandbox.growth * (t.growth_pct / 100) + m.age_slope * t.log_age + t.category_offset;
  return Math.max(1, Math.round(10 ** logV));
}

let sortKey = 'implied_value_usd';
let sortDir = -1;

function currentRows() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('category').value;
  const verdict = $('verdict').value;
  const watchOnly = $('watchonly').checked;
  const watch = new Set(R.rows.filter((r) => r.on_watchlist).map((r) => r.slug));
  let rows = R.rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q))) return false;
    if (cat && r.category !== cat) return false;
    if (verdict && r.verdict !== verdict) return false;
    if (watchOnly && !watch.has(r.slug)) return false;
    return true;
  });
  const key = sortKey === 'implied_value_usd' ? (r) => shownImplied(r)
    : sortKey === 'expected_value_usd' ? (r) => shownImplied(r) * r.token_odds
    : (r) => r[sortKey] ?? -Infinity;
  rows = [...rows].sort((a, b) => {
    const va = key(a), vb = key(b);
    if (typeof va === 'string') return sortDir * va.localeCompare(vb);
    return sortDir * (va - vb) || (a.slug < b.slug ? -1 : 1);
  });
  return rows;
}

function renderTable() {
  const rows = currentRows();
  $('count').textContent = `${rows.length} of ${R.board_size} rows`;
  $('rows').innerHTML = rows.map((r) => {
    const implied = shownImplied(r);
    const expected = Math.max(1, Math.round(implied * r.token_odds));
    const g = r.change_7d;
    const gCls = g === null ? '' : g >= 0 ? 'pos' : 'neg';
    return `<tr data-slug="${esc(r.slug)}"><td class="mono">${r.rank}</td>`
      + `<td><b>${esc(r.name)}</b><br><span class="dim mono">${esc(r.slug)}</span></td>`
      + `<td>${esc(r.category ?? '—')}</td>`
      + `<td class="num">${money(r.tvl_usd)}</td>`
      + `<td class="num ${gCls}">${pct(g)}</td>`
      + `<td class="num">${age(r.age_days)}</td>`
      + `<td class="num"><b>${money(implied)}</b></td>`
      + `<td class="num">${(r.token_odds * 100).toFixed(0)}%</td>`
      + `<td class="num">${money(expected)}</td>`
      + `<td><span class="tag ${r.verdict}">${r.verdict}</span></td></tr>`;
  }).join('');
}

/* The detail view: the value equation with its numbers, the odds, the costed farm plan. */
function openDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const m = R.model;
  const t = r.model;
  const implied = shownImplied(r);
  const expected = Math.max(1, Math.round(implied * r.token_odds));
  const eq = `log10(value) = ${m.intercept} + ${m.tvl_slope} x ${t.log_tvl} (log10 TVL)`
    + ` + ${t.growth_weight} x ${(t.growth_pct / 100).toFixed(2)} (growth)`
    + ` + ${m.age_slope} x ${t.log_age} (log10 age) + ${t.category_offset} (${esc(r.category ?? 'no category')} offset)`
    + ` = ${t.log_implied}  ->  ${money(implied)}`;
  $('detail-body').innerHTML =
    `<h2>${esc(r.name)} <span class="tag ${r.verdict}">${r.verdict}</span></h2>`
    + `<p class="dim">Rank ${r.rank} of ${R.board_size} · ${esc(r.category ?? 'no category')} · ${esc(r.chains.join(', ') || 'no chain listed')} · TVL ${money(r.tvl_usd)} · 7d ${pct(r.change_7d)} · age ${age(r.age_days)}</p>`
    + `<h3>Implied value — the equation, with its numbers</h3><div class="eq">${eq}</div>`
    + `<p>Implied <b>${money(implied)}</b> · token odds <b>${(r.token_odds * 100).toFixed(0)}%</b> (peers' record, ${r.odds_peers} peers) · expected value <b>${money(expected)}</b>.</p>`
    + `<h3>Farm plan — concrete steps, with costs and times</h3>`
    + `<ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  $('detail').showModal();
}

function renderModel() {
  const m = R.model;
  $('terms').querySelector('tbody').innerHTML = m.terms.map((t) =>
    `<tr><td>${esc(t.name)}</td><td class="num">${t.fitted}</td><td class="num">${t.applied}</td><td>${esc(t.note)}</td></tr>`).join('')
    + Object.entries(m.category_offsets).map(([c, v]) =>
      `<tr><td>offset: ${esc(c)}</td><td class="num">${v}</td><td class="num">${v}</td><td>category offset (reference: ${esc(m.reference_category)})</td></tr>`).join('');
  $('tests').textContent =
    `Fitted on ${m.fit_n} traded protocols (R² ${m.r2}). Held-out test 1 — leave-one-out: median error x${m.loo_multiple}. `
    + `Held-out test 2 — walk-forward, older half trains, newer half is scored: median error x${m.walkforward_multiple}. `
    + `A value this model states is a fitted estimate with a measured error, not a promise.`;
}

function renderAudit() {
  const a = R.audit;
  const items = [
    ['Ranked on the board', a.ranked],
    ['Token already trades (live set)', a.live_token],
    ['Wrapped / staked / bridged — never ranked as launches', a.wrapped_or_staked],
    ['TOTAL — every protocol in the snapshot', a.total],
  ];
  $('audit-list').innerHTML = items.map(([label, n]) => `<li><span>${label}</span><b>${n}</b></li>`).join('');
}

function renderLive() {
  $('live-table').querySelector('tbody').innerHTML = R.live.map((p) => {
    const ratio = p.mcap_usd && p.tvl_usd ? (p.mcap_usd / p.tvl_usd).toFixed(2) + 'x' : '—';
    return `<tr><td><b>${esc(p.name)}</b><br><span class="dim mono">${esc(p.slug)}</span></td>`
      + `<td>${esc(p.category ?? '—')}</td><td class="num">${money(p.tvl_usd)}</td>`
      + `<td class="num">${p.mcap_usd ? money(p.mcap_usd) : '—'}</td><td class="num">${ratio}</td></tr>`;
  }).join('');
}

function init() {
  renderKpi();
  renderModel();
  renderAudit();
  renderLive();
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  $('category').innerHTML = '<option value="">All categories</option>'
    + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  for (const id of ['q', 'category', 'verdict', 'watchonly']) {
    $(id).addEventListener('input', renderTable);
    $(id).addEventListener('change', renderTable);
  }
  $('sort').addEventListener('change', () => {
    const v = $('sort').value;
    sortKey = v === 'implied' ? 'implied_value_usd' : v === 'expected' ? 'expected_value_usd'
      : v === 'odds' ? 'token_odds' : v === 'tvl' ? 'tvl_usd' : 'change_7d';
    sortDir = -1;
    renderTable();
  });
  document.querySelectorAll('#board thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (k === sortKey) sortDir = -sortDir;
      else { sortKey = k; sortDir = k === 'name' || k === 'category' || k === 'verdict' ? 1 : -1; }
      renderTable();
    });
  });
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  $('detail-close').addEventListener('click', () => $('detail').close());
  $('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
  const tvl = $('sb-tvl'), growth = $('sb-growth');
  const applySandbox = () => {
    sandbox = { tvl: parseFloat(tvl.value), growth: parseFloat(growth.value) };
    $('sb-tvl-v').textContent = sandbox.tvl.toFixed(2) + 'x';
    $('sb-growth-v').textContent = sandbox.growth.toFixed(1);
    renderTable();
  };
  tvl.addEventListener('input', applySandbox);
  growth.addEventListener('input', applySandbox);
  $('sb-reset').addEventListener('click', () => {
    tvl.value = '1'; growth.value = '0'; sandbox = null;
    $('sb-tvl-v').textContent = '1.00x'; $('sb-growth-v').textContent = '0.0';
    renderTable();
  });
  renderTable();
}

init();

