<script>
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import ConfigDiff from '$lib/components/ConfigDiff.svelte';
  import EconPanel from '$lib/components/EconPanel.svelte';
  import GateTable from '$lib/components/GateTable.svelte';
  import HistoryTable from '$lib/components/HistoryTable.svelte';
  import Ruler from '$lib/components/Ruler.svelte';
  import TwoColumn from '$lib/components/TwoColumn.svelte';
  import TxWindow from '$lib/components/TxWindow.svelte';
  import { api } from '$lib/services/api';
  import { cols, findVault, positionOf, seed, status, vaults } from '$lib/stores/status';
  import { hrefFor, nav, stateFromUrl, VIEWS } from '$lib/stores/keys';
  import {
    ageOf,
    bar,
    fmtAge,
    fmtBlock,
    fmtClockS,
    fmtDueIn,
    fmtHuman,
    fmtMult,
    fmtPct,
    fmtTick,
    fmtToken,
    fmtWei,
    kindAbbr,
    mapGlyphs,
    offMid,
    ruler,
    shortAddr,
    shortHash,
    vaultText,
    weiToNumber,
  } from '$lib/utils/text';

  // the drill: why is this vault (not) acting. ?view= picks the screen; the url is the state.
  export let data = {};

  // the monitor's chain-only verdicts, in the mockup's order. `!` = firing
  const CHAIN_ROWS = [
    ['out-of-band', 'out-of-band'],
    ['rebalance-overdue', 'overdue'],
    ['limit-stranded', 'stranded'],
    ['clamp-blocking', 'clamp-blocking'],
    ['paused', 'paused'],
    ['gas', 'gas'], // monitor 0.4.0 folded gas-warn/gas-floor into one family
    ['divergence', 'divergence'],
  ];
  const ECON_COLS = ['launch', '7d', '24h'];
  const REFRESH_MS = 30000;
  const REGIME_STALE_SECS = 7200;

  $: seed(data);

  let now = Date.now();
  let clock;
  let refresher;
  let loadedKey = null;
  let viewError = '';
  let gates = null;
  let cycles = [];
  let txs = [];
  let econCols = [];
  let econSamples = [];
  let cfg = null;
  let logLines = [];
  let expanded = null;

  $: agent = $page.url.searchParams.get('agent') === '1';
  $: urlState = stateFromUrl($page.url);
  $: view = urlState.view === 'fleet' ? 'vault' : urlState.view;
  $: filter = $page.url.searchParams.get('filter') ?? 'all';
  $: v = findVault($vaults, urlState.vault);
  $: pos = positionOf($vaults, v);
  $: k = v?.keeper ?? null;
  $: c = v?.chain ?? null;
  $: gas = $status?.keeper?.gas ?? null;
  $: compact = agent || $cols < 60;
  $: wide = $cols >= 78;
  $: rulerCells = Math.max(24, Math.min(wide ? 78 : 40, $cols - 6));

  // --- the band ruler ---------------------------------------------------------------
  $: twapTick = k?.gateSaw?.twap?.tick ?? v?.monitor?.snapshot?.twapTick ?? null;
  $: oracleTick = k?.gateSaw?.oracle?.tick ?? v?.monitor?.snapshot?.oracleTick ?? null;
  $: midTick = c ? Math.round((c.base.lower + c.base.upper) / 2) : null;
  $: rulerInput = c
    ? {
        lower: c.base.lower,
        upper: c.base.upper,
        spot: c.spotTick,
        twap: twapTick,
        oracle: oracleTick,
        mid: midTick,
        limit: [c.limit.lower, c.limit.upper],
        limitLiquidity: c.limit.liquidity,
        cells: rulerCells,
      }
    : null;
  $: span = rulerInput ? ruler(rulerInput).span : null;

  // --- keeper says / chain says ------------------------------------------------------
  function legBar(leg) {
    if (!leg || !leg.requiredSecs) return null;
    return {
      ratio: leg.requiredSecs ? leg.heldSecs / leg.requiredSecs : null,
      text: `${fmtAge(leg.heldSecs)}/${fmtAge(leg.requiredSecs)}`,
      cells: 8,
    };
  }

  function legValue(leg, word) {
    if (!leg) return '-';
    if (leg.armed) return word;
    return leg.heldSecs > 0 ? 'arming' : '-';
  }

  $: regimeAge = k?.regime?.lastEvaluatedAt ? ageOf(k.regime.lastEvaluatedAt, now) : null;
  $: balance = weiToNumber(gas?.signerBalanceWei);
  $: floor = weiToNumber(gas?.floorWei);
  $: leftRows = k
    ? [
        {
          label: 'trigger',
          value: legValue(k.dwell?.rebalance, 'TRIGGER'),
          cls: k.dwell?.rebalance?.armed ? 's-armed' : '',
          bar: legBar(k.dwell?.rebalance),
          detail: c ? `drift ${c.base.driftTicks}${c.base.thresholdTicks != null ? ' > ' + c.base.thresholdTicks : ''}` : '',
        },
        {
          label: 'refresh',
          value: legValue(k.dwell?.refresh, 'REFRESH'),
          cls: k.dwell?.refresh?.armed ? 's-armed' : '',
          bar: legBar(k.dwell?.refresh),
          detail: c ? `limit ${c.limit.outsideByTicks} ticks ${c.limit.side ?? 'away'}` : '',
        },
        {
          label: 'fold',
          value: legValue(k.dwell?.fold, 'FOLD'),
          cls: k.dwell?.fold?.armed ? 's-armed' : '',
          bar: legBar(k.dwell?.fold),
          detail: c ? `limit share ${fmtPct(c.composition.limitShare)}` : '',
        },
        {
          label: 'cooldown',
          value: k.cooldown ? (k.cooldown.skipped ? 'HELD' : 'ok') : '-',
          cls: k.cooldown?.skipped ? 's-held' : '',
          detail: k.cooldown
            ? `last ${fmtAge(k.cooldown.elapsedSecs)} ago  (min ${fmtAge(k.cooldown.minIntervalSecs)}, ${v.entrypoint})`
            : 'not evaluated',
        },
        {
          label: 'gate',
          value: k.gateSaw ? (k.gateSaw.ok ? 'ok' : 'BLOCKED') : '-',
          cls: k.gateSaw && !k.gateSaw.ok ? 's-held' : '',
          detail: k.gateSaw ? mapGlyphs(k.gateSaw.reason ?? '') : 'not evaluated this cycle',
        },
        {
          label: 'regime',
          value: (k.regime?.regime ?? '-').toUpperCase(),
          cls: k.regime?.regime === 'extreme' ? 's-fault' : k.regime?.regime === 'elevated' ? 's-held' : '',
          detail: k.regime
            ? `vol ${fmtMult(k.regime.inputs?.volRatio)}  15m ${fmtPct(k.regime.inputs?.move15mFrac)}  eval ${fmtClockS(k.regime.lastEvaluatedAt)}`
            : '-',
          detailCls: regimeAge != null && regimeAge > REGIME_STALE_SECS ? 's-stale' : '',
        },
        {
          label: 'gas',
          value: balance == null ? '-' : floor != null && balance <= floor ? 'LOW' : 'ok',
          cls: balance != null && floor != null && balance <= floor ? 's-fault' : '',
          detail: gas ? `${fmtWei(gas.signerBalanceWei)} >= ${fmtHuman(floor)} floor` : '-',
        },
        {
          label: 'compound',
          value: k.compound ? fmtDueIn(k.compound.dueInSecs) : '-',
          cls: k.compound?.due ? 's-armed' : '',
          detail: c?.feesOwed ? `owed ${fmtToken(c.feesOwed.fees0)} + ${fmtToken(c.feesOwed.fees1)}` : '',
        },
      ]
    : [];

  $: firing = new Map((v?.monitor?.firing ?? []).map((f) => [f.key, f]));
  $: rightRows = [
    {
      label: 'monitor',
      value: v?.monitor?.reachable ? `${fmtAge(v.monitor.ageSecs)} ago` : 'down',
      cls: v?.monitor?.reachable ? (v.monitor.stale ? 's-stale' : 's-off') : 's-off',
    },
    ...CHAIN_ROWS.map(([key, label]) => {
      const f = firing.get(key);
      return {
        label,
        value: f ? '!' : 'no',
        cls: f ? (f.severity === 'critical' ? 's-fault' : 's-held') : 's-success',
      };
    }),
  ];

  $: disagree = v?.disagreements ?? [];

  // --- per-view data ------------------------------------------------------------------
  $: econWindows = ECON_COLS.includes($nav.window) ? ECON_COLS : [$nav.window, ...ECON_COLS].slice(0, 3);

  async function loadView(name, id, win, which, force = false) {
    const key = `${name}:${id}:${win}:${which}`;
    if (!browser || !id || (!force && key === loadedKey)) return;
    loadedKey = key;
    viewError = '';
    try {
      if (name === 'gates') {
        gates = (await api.gates(id)).data;
      } else if (name === 'history') {
        if (which === 'log') {
          logLines = (await api.log(id)).data?.lines ?? [];
        } else {
          const [cyc, tx] = await Promise.all([
            api.cycles(id, { limit: 200, order: 'desc' }),
            api.txs(id, { limit: 50, order: 'desc' }),
          ]);
          cycles = cyc.data?.items ?? [];
          txs = tx.data?.items ?? [];
        }
      } else if (name === 'econ') {
        econCols = await Promise.all(
          econWindows.map(async (w) => {
            try {
              return { window: w, data: (await api.economics(id, w)).data };
            } catch {
              return { window: w, data: null };
            }
          }),
        );
        const sel = econCols.find((x) => x.window === win) ?? econCols[0];
        econSamples = sel?.data ? await loadSamples(id, sel.data) : [];
      } else if (name === 'config') {
        cfg = (await api.config()).data;
      }
    } catch (e) {
      viewError = e?.message ?? 'api unreachable';
    }
  }

  async function loadSamples(id, econ) {
    const from = econ.window?.from?.ts ?? null;
    const to = econ.window?.to?.ts ?? null;
    if (from == null || to == null) return [];
    // <= 5000 points: 5 minutes up to two days, hourly beyond
    const step = to - from <= 172800 ? 300 : 3600;
    const res = await api.samples(id, { from, to, step, fields: 'sharePrice,inBase' });
    return res.data?.items ?? [];
  }

  $: loadView(view, v?.id ?? null, $nav.window, filter);

  function switchView(next) {
    const href = hrefFor(next, $nav, { vault: $nav.vault, filter: next === 'history' ? filter : null });
    if (href) goto(href, { replaceState: true });
  }

  onMount(() => {
    if (!browser) return;
    clock = setInterval(() => (now = Date.now()), 1000);
    refresher = setInterval(() => loadView(view, v?.id ?? null, $nav.window, filter, true), REFRESH_MS);
  });

  onDestroy(() => {
    if (clock) clearInterval(clock);
    if (refresher) clearInterval(refresher);
  });
</script>

{#if !v}
  <div class="s-stale">vault not found · <a href="/">back to the fleet</a></div>
{:else if agent}
  <pre class="agent-text">{vaultText(v, $status, { now }).join('\n')}</pre>
  {#if view === 'gates'}<GateTable {gates} {now} compact />{/if}
  {#if view === 'econ'}<EconPanel econ={econCols.find((x) => x.window === $nav.window)?.data ?? null} columns={econCols} selected={$nav.window} samples={econSamples} compact />{/if}
  {#if view === 'config'}<ConfigDiff config={cfg} vault={v} {now} compact />{/if}
  {#if view === 'history'}<HistoryTable items={cycles} {txs} {filter} {now} compact />{/if}
{:else}
  <div class="tui-panel drill">
    <div class="title">
      <span class="head">{v.label}</span>
      {#if wide}<span class="s-off">{shortAddr(v.id)}</span><span class="s-off">{v.entrypoint}</span>{/if}
      <span class={k?.regime?.regime === 'calm' ? 's-success' : 's-held'}>{(k?.regime?.regime ?? '-').toUpperCase()}</span>
      <span class="grow"></span>
      {#if pos.total > 1}<span class="s-off">{pos.index + 1} of {pos.total} »</span>{/if}
    </div>

    <div class="tabs">
      {#each VIEWS.filter((x) => x.id !== 'fleet') as tab}
        <button class="tab" class:current={tab.id === view} on:click={() => switchView(tab.id)}>
          {tab.id === view ? `[${tab.short}]` : tab.short}
        </button>
      {/each}
      {#if viewError}<span class="s-stale">{viewError}</span>{/if}
    </div>

    {#if view === 'vault'}
      {#if c}
        <div class="line s-off"><span>ticks {span ? span[0] : '-'}</span><span class="grow"></span><span>{span ? span[1] : '-'}</span></div>
        <Ruler {...rulerInput} {compact} />
        <div class="line">
          <span>spot {fmtTick(c.spotTick)}</span>
          {#if twapTick != null}<span>twap {fmtTick(twapTick)} (t)</span>{/if}
          {#if oracleTick != null}<span>oracle {fmtTick(oracleTick)} (o)</span>{/if}
          {#if wide}<span class="s-off">mid {fmtTick(midTick)} (m)</span><span>{fmtHuman(c.price?.human)}</span>{/if}
        </div>
        <div class="line">
          <span class={c.base.thresholdTicks != null && c.base.driftTicks > c.base.thresholdTicks ? 's-armed' : ''}
            >drift {c.base.driftTicks}{c.base.thresholdTicks != null ? ` > ${c.base.thresholdTicks}` : ''}</span
          >
          <span class={c.base.inRange ? 's-success' : 's-fault'}>{offMid({ lower: c.base.lower, upper: c.base.upper, spot: c.spotTick })}</span>
          {#if wide}
            <span class="s-off">limit {c.limit.lower}-{c.limit.upper}</span>
            <span class={c.limit.stranded ? 's-fault' : 's-off'}>{c.limit.outsideByTicks} {c.limit.side ?? ''}</span>
          {/if}
        </div>
      {:else}
        <div class="line s-stale">chain: no sample yet</div>
      {/if}

      <TwoColumn
        left={leftRows}
        right={rightRows}
        {compact}
        leftTitle={k?.reachable ? `keeper says  block ${fmtBlock(k.asOf?.block)} (${fmtAge(k.ageSecs)})` : 'keeper says  unreachable'}
        rightTitle="chain says"
      />

      <div class="line verdict">
        <span class="label">verdict</span>
        <span
          class={v.verdict.level === 'fault' ? 's-fault' : v.verdict.level === 'held' ? 's-held' : v.verdict.level === 'ok' ? 's-success' : 's-off'}
          >{v.verdict.level.toUpperCase()}</span
        >
        <span>{mapGlyphs(v.verdict.sentence)}</span>
        <span class="grow"></span>
        <span class={disagree.length ? 's-fault' : 's-success'}>{disagree.length ? `disagree ${disagree.length}` : 'agree √'}</span>
      </div>
      {#each disagree as d}
        <div class="line s-fault"><span class="label">{d.key}</span><span>{mapGlyphs(d.detail ?? '')}</span></div>
      {/each}

      {#if c}
        <div class="block">
          <div class="line">
            <span>nav {fmtHuman(c.nav.navToken1)} {c.nav.total1.symbol}</span>
            <span>X {fmtPct(c.composition.token0Share)} {c.nav.total0.symbol}</span>
            {#if !compact}
              <span>base {fmtPct(c.composition.baseShare)}</span>
              <span>{bar(c.composition.baseShare, 10)}</span>
              <span>limit {fmtPct(c.composition.limitShare)}</span>
            {/if}
            <span class="s-off">2X-1 {fmtPct(c.composition.twoXMinusOne)}</span>
          </div>
          <div class="line">
            <span
              >last act {k?.lastTx ? `${fmtAge(ageOf(k.lastTx.ts, now))} ${kindAbbr(k.lastTx.kind)} ${shortHash(k.lastTx.hash)}` : '-'}</span
            >
            <span class={c.deposits.state === 'open' ? 's-success' : 's-held'}>deposits {c.deposits.state}</span>
            <span class="s-off">shares {fmtHuman(weiToNumber(c.shares.totalSupply))}</span>
          </div>
        </div>
      {/if}
    {:else if view === 'gates'}
      <div class="line s-off">
        <span>as of {gates?.asOf ? fmtClockS(gates.asOf.ts) : '-'}</span>
        <span>keeper saw {gates?.keeperSawAt ? fmtClockS(gates.keeperSawAt) : 'never'}</span>
      </div>
      <GateTable {gates} {now} {compact} />
    {:else if view === 'history'}
      {#if filter === 'log'}
        <pre class="log">{logLines.map((l) => mapGlyphs(l.line)).join('\n')}</pre>
      {:else}
        <HistoryTable items={cycles} {txs} {filter} {now} {compact} on:open={(e) => (expanded = e.detail)} />
      {/if}
    {:else if view === 'econ'}
      <EconPanel
        econ={econCols.find((x) => x.window === $nav.window)?.data ?? econCols[0]?.data ?? null}
        columns={econCols}
        selected={$nav.window}
        samples={econSamples}
        {compact}
        cells={Math.max(24, Math.min(72, $cols - 6))}
      />
    {:else if view === 'config'}
      <ConfigDiff config={cfg} vault={v} {now} {compact} />
    {/if}
  </div>

  {#if expanded}
    <TxWindow record={expanded.record} tx={expanded.tx} {now} on:close={() => (expanded = null)} />
  {/if}
{/if}

<style>
  .drill {
    display: block;
    width: 100%;
    padding: 0 1ch;
  }

  .title,
  .line,
  .tabs {
    display: flex;
    gap: 2ch;
    white-space: pre;
    overflow: hidden;
  }

  .title {
    border-bottom: 2px solid var(--frame);
  }

  .head {
    color: var(--head-text);
  }

  .grow {
    flex: 1 1 auto;
  }

  .label {
    display: inline-block;
    min-width: 8ch;
    color: var(--muted);
  }

  .tabs {
    gap: 1ch;
    border-bottom: 2px solid var(--frame);
  }

  .tab {
    background: none;
    border: none;
    font: inherit;
    color: var(--muted);
    cursor: pointer;
    padding: 0;
  }

  .tab.current {
    color: var(--head-text);
  }

  .verdict {
    border-top: 2px solid var(--frame);
    padding-top: 2px;
  }

  .block {
    border-top: 2px solid var(--frame);
    margin-top: 2px;
    padding-top: 2px;
  }

  .log,
  .agent-text {
    margin: 0;
    font: inherit;
    white-space: pre;
    overflow-x: hidden;
    color: var(--panel-text);
  }
</style>
