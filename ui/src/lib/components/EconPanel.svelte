<script>
  import Strip from './Strip.svelte';
  import { textChartCell } from '../utils/chart';
  import { fmtDate, fmtHuman, fmtNum, fmtPct, fmtToken, fmtWei, weiToNumber } from '../utils/text';

  // net vs both hodl benchmarks, fees vs residual, time in range, cadence, cost, runway, skim
  // and flows. everything under `experimental` is the api's own label — it stays until the
  // 9-day figures reconcile against an independent source.
  export let econ = null;
  // [{ window, data }] — the mockup's launch / 7d / 24h columns, selected one first in the title
  export let columns = [];
  export let selected = '7d';
  export let samples = [];
  export let compact = false;
  export let cells = 72;

  const CHART_ROWS = 3;

  // a share price lives around 1.0; fmtHuman's 2 decimals would hide the whole move
  const sp = (x) => (x == null || !Number.isFinite(Number(x)) ? '-' : Number(x).toFixed(4));

  function pctCls(x) {
    if (x == null) return 's-off';
    return x >= 0 ? 's-success' : 's-fault';
  }

  function value(col, pick) {
    return col?.data ? pick(col.data) : null;
  }

  $: series = (samples ?? []).map((s) => s.sharePrice).filter((x) => x != null && Number.isFinite(x));
  $: lo = series.length ? Math.min(...series) : 0;
  $: hi = series.length ? Math.max(...series) : 0;
  // a share price sits near 1.0: a zero-based bar would be a flat wall, so the bed is the
  // window's own min/max
  $: chart = series.length
    ? series.map((v) => (hi > lo ? Math.max(1, Math.round(((v - lo) / (hi - lo)) * CHART_ROWS * 2)) : CHART_ROWS))
    : [];
  $: thinned = chart.length > cells ? Array.from({ length: cells }, (_, i) => chart[Math.round((i * (chart.length - 1)) / (cells - 1))]) : chart;
  $: chartRows = Array.from({ length: CHART_ROWS }, (_, r) =>
    thinned.map((h) => textChartCell(h, CHART_ROWS - 1 - r)).join(''),
  );
  $: flags = (samples ?? []).map((s) => (s.inBase == null ? null : !!s.inBase));
  $: skim = econ?.experimental?.skim ?? null;
  $: fp0 = skim?.feeProtocol == null ? null : skim.feeProtocol & 0xf;
  $: cost = econ?.cost ?? null;
  $: gas = econ?.gas ?? null;
  $: burn = weiToNumber(gas?.burnPerDayWei);
</script>

{#if econ}
  <table class="bench">
    <thead>
      <tr>
        <th class="what"></th>
        {#each columns as col}
          <th class="num" class:sel={col.window === selected}>{col.window}</th>
        {/each}
        <th class="note"></th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="what">net vs deposited basket</td>
        {#each columns as col}
          <td class="num {pctCls(value(col, (d) => d.netVsBasketHodl))}"
            >{fmtPct(value(col, (d) => d.netVsBasketHodl), { signed: true, digits: 2 })}</td
          >
        {/each}
        <td class="note s-off">per share</td>
      </tr>
      <tr>
        <td class="what">net vs 50/50 hodl</td>
        {#each columns as col}
          <td class="num {pctCls(value(col, (d) => d.netVs5050Hodl))}"
            >{fmtPct(value(col, (d) => d.netVs5050Hodl), { signed: true, digits: 2 })}</td
          >
        {/each}
        <td class="note s-off">spec E benchmark</td>
      </tr>
      <tr>
        <td class="what">  fees (retained)</td>
        {#each columns as col}
          <td class="num {pctCls(value(col, (d) => d.experimental.feesFrac))}"
            >{fmtPct(value(col, (d) => d.experimental.feesFrac), { signed: true, digits: 2 })}</td
          >
        {/each}
        <td class="note s-off">ZeroBurn + owed</td>
      </tr>
      <tr>
        <td class="what">  il + rebase (residual)</td>
        {#each columns as col}
          <td class="num {pctCls(value(col, (d) => d.experimental.ilFrac))}"
            >{fmtPct(value(col, (d) => d.experimental.ilFrac), { signed: true, digits: 2 })}</td
          >
        {/each}
        <td class="note s-off">net - fees</td>
      </tr>
    </tbody>
  </table>

  <div class="line">
    <span>share price {sp(econ.perShare?.spStart)} -> {sp(econ.perShare?.spEnd)}</span>
    <span class="s-off">experimental until checksummed</span>
  </div>

  {#if !compact && thinned.length > 1}
    <div class="chart">
      {#each chartRows as row}
        <div class="chart-row">{row}</div>
      {/each}
      <div class="s-off legend">share price {sp(lo)} .. {sp(hi)}</div>
    </div>
  {/if}

  <div class="block">
    <div class="line">
      <span class="label">time in range</span>
      <span>base {fmtPct(econ.timeInRange?.base)}</span>
      <span>limit active {fmtPct(econ.timeInRange?.limit)}</span>
      <span class="s-off">tw base share {fmtPct(econ.timeInRange?.twBaseShare)}</span>
    </div>
    <Strip {flags} {compact} {cells} from={fmtDate(econ.window?.from?.ts)} to={fmtDate(econ.window?.to?.ts)} />
  </div>

  <div class="block">
    <div class="line">
      <span class="label">actions</span>
      <span>recenter {fmtNum(econ.actions?.recenter)}</span>
      <span>refresh {fmtNum(econ.actions?.refresh)}</span>
      <span>fold {fmtNum(econ.actions?.fold)}</span>
      <span>compound {fmtNum(econ.actions?.compound)}</span>
    </div>
    <div class="line">
      <span class="label">cadence</span>
      <span>{econ.cadence?.perDay != null ? econ.cadence.perDay.toFixed(2) + '/day' : '-'}</span>
      <span class="s-off"
        >(policy cap {econ.cadence?.policyCapPerDay ?? '-'}, proxy spacing {econ.cadence?.proxyCapPerDay ?? '-'})</span
      >
      <span class={econ.cadence?.minGapOk === false ? 's-fault' : 's-off'}
        >min gap {econ.cadence?.minGapOk === false ? 'BREACHED' : 'ok'}</span
      >
    </div>
    <div class="line">
      <span class="label">cost per tx</span>
      <span>reb {fmtWei(cost?.avgCostWei?.recenter)}</span>
      <span>cmp {fmtWei(cost?.avgCostWei?.compound)}</span>
      <span class="s-off">total {fmtWei(cost?.totalWei)}{cost?.costSource === 'estimate' ? ' (estimated)' : ''}</span>
    </div>
    <div class="line">
      <span class="label">gas runway</span>
      <span>{fmtWei(gas?.balanceWei)}</span>
      <span class="s-off">/ {burn == null ? '-' : fmtHuman(burn)} per day</span>
      <span class={gas?.runwayDays != null && gas.runwayDays < 7 ? 's-fault' : ''}
        >= {gas?.runwayDays != null ? Math.floor(gas.runwayDays) + 'd' : '-'}</span
      >
      <span class="s-off">warn {fmtHuman(weiToNumber(gas?.warnWei))}</span>
    </div>
    <div class="line">
      <span class="label">skim</span>
      <span>{fmtToken(skim?.amount0)} + {fmtToken(skim?.amount1)}</span>
      <span class="s-off"
        >(fee divisor {skim?.feeDivisor ?? '-'}, {fp0 ? `1/${fp0}` : fp0 === 0 ? 'no' : '-'} protocol)</span
      >
    </div>
    <div class="line">
      <span class="label">flows</span>
      <span>{fmtNum(econ.flows?.deposits)} dep</span>
      <span>{fmtNum(econ.flows?.withdrawals)} wd</span>
      <span>{fmtNum(econ.flows?.depositors)} depositors</span>
      <span class="s-off"
        >supply {fmtHuman(weiToNumber(econ.flows?.supplyStart))} -> {fmtHuman(weiToNumber(econ.flows?.supplyEnd))}</span
      >
    </div>
  </div>
{:else}
  <div class="s-off">no economics for this window yet</div>
{/if}

<style>
  .bench {
    border-collapse: collapse;
  }

  .bench td,
  .bench th {
    padding: 0 1ch 0 0;
    white-space: pre;
    text-align: left;
  }

  .what {
    width: 26ch;
  }

  .num {
    width: 9ch;
    text-align: right;
  }

  .sel {
    color: var(--head-text);
  }

  .line {
    display: flex;
    gap: 2ch;
    white-space: pre;
    overflow: hidden;
  }

  .label {
    display: inline-block;
    min-width: 16ch;
    color: var(--muted);
  }

  .block {
    border-top: 2px solid var(--frame);
    margin-top: 2px;
    padding-top: 2px;
  }

  .chart-row,
  .legend {
    white-space: pre;
    overflow: hidden;
  }

  .chart-row {
    color: var(--bright);
  }
</style>
