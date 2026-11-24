# Token Radar v2 — fitted launch pricing, tested held-out twice

[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/xomgenit/token-radar-v2-makefun/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/xomgenit/token-radar-v2-makefun/reward.svg)](https://make.fun/bounty/token-radar-01)

Entry for the [make.fun Token Radar bounty](https://make.fun/bounty/token-radar-01): build the best token launch radar.

## What it does

Reads the sealed DefiLlama snapshot (758 protocols), ranks every pre-token protocol by an
implied launch value, and hands the reader a dashboard with the board, a detail view per
protocol, and a costed farm plan for each one.

## The model (radar-3) — fitted, not assumed

`log10(market cap) = a + b·log10(TVL) + d·log10(age) + category offsets`,
fitted by least squares on the snapshot's traded protocols. Then tested held-out twice
before any value is shown:

- **Leave-one-out**: refit without each protocol, score the one left out.
- **Walk-forward**: the older half trains, the newer half is scored.

Both error multiples print on the dashboard's cover strip. Growth is fitted separately
on the residuals and comes out noise (slope −0.94, R² 0.008), so the model holds it at
zero and says so — it does not pay for what the data does not price.

## Token odds — the peers' record

Odds are the share of protocols in the same category and age band that already record a
token, shrunk toward the global rate. Expected value is implied value × odds. Odds are a
base rate, not a prediction of whether or when a token is issued.

## Farm plans — costed verdicts

Seven steps per protocol, each with a cost and a time, ending in a verdict step that nets
the whole plan to the dollar: FARM, WATCH, or SKIP. Gas is priced by the protocol's main
chain; capital is sized by its TVL.

## The 758 audit

Every protocol in the snapshot is in exactly one bucket — ranked, token already trades,
or wrapped/staked/bridged and never ranked as a launch — and the counts sum to 758.
The watchlist is covered 40 of 40.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22+, standard library only, no network. Deterministic: two runs write the same bytes.
