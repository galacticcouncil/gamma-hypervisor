<script>
  import Bar from './Bar.svelte';
  import { ageOf, fmtAge, fmtClock, fmtHuman } from '../utils/text';

  // every AND-ed gate as reading vs threshold, with the keeper's own last-evaluated value
  // beside it. gates not configured on this vault render `off`; limits are the live /config
  // values the api publishes, never literals.
  export let gates = null;
  export let now = undefined;
  export let compact = false;

  const FAIL = /^(FAIL|BLOCKED|EXTREME|STALE)/;
  const ARMED = /^(TRIGGER|REFRESH|FOLD|armed|clamp|due)/;

  $: rows = gates?.rows ?? [];
  $: holding = gates?.holding ?? null;

  function cell(v) {
    if (v == null) return '-';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number') return fmtHuman(v);
    return v;
  }

  function verdictCls(row) {
    if (!row.enabled) return 's-off';
    const v = String(row.verdict ?? '');
    if (FAIL.test(v)) return 's-fault';
    if (ARMED.test(v)) return 's-armed';
    if (v === '-' || v === 'n/a') return 's-off';
    return 's-success';
  }

  // the failing row that the standing names, so the paragraph quotes real readings
  $: failing = rows.find((r) => r.enabled && FAIL.test(String(r.verdict ?? ''))) ?? null;
  $: spotVsOracle = rows.find((r) => r.gate === 'spot vs oracle') ?? null;
  // spot agrees with the feed while the pool twap does not: the twap lags a fast move (wiki
  // §7.3), not manipulation. only claimed when both readings are on the screen
  $: twapLag =
    holding?.subcode === 'oracle-dev' &&
    spotVsOracle != null &&
    !FAIL.test(String(spotVsOracle.verdict ?? '')) &&
    failing != null;
  $: since = holding ? `${fmtClock(holding.sinceTs)} (${fmtAge(ageOf(holding.sinceTs, now))})` : '';
</script>

<table class="tui-table gates">
  <thead>
    <tr>
      <th class="gate">gate</th>
      <th class="reading">reading</th>
      <th class="limit">limit</th>
      {#if !compact}<th class="bar">0%      100%</th>{/if}
      <th class="verdict">verdict</th>
      <th class="saw">saw</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row (row.gate)}
      <tr class:off={!row.enabled}>
        <td class="gate">{row.gate}</td>
        <td class="reading" class:s-off={!row.enabled}>{row.enabled ? cell(row.reading) : 'off'}</td>
        <td class="limit s-off">{row.enabled ? `${row.op ?? ''} ${cell(row.limit)}`.trim() : ''}</td>
        {#if !compact}
          <td class="bar">
            <Bar ratio={row.ratio} off={!row.enabled} fail={verdictCls(row) === 's-fault'} />
          </td>
        {/if}
        <td class="verdict {verdictCls(row)}">{row.enabled ? row.verdict : 'off'}</td>
        <td class="saw" class:s-fault={row.agrees === false}>{cell(row.keeperSaw)}</td>
      </tr>
    {:else}
      <tr><td class="s-off" colspan="6">no gate reading yet</td></tr>
    {/each}
  </tbody>
</table>

{#if holding}
  <div class="holding">
    <p class="s-held">
      holding: {failing ? `${failing.gate} ${cell(failing.reading)} ${failing.op ?? 'vs'} ${cell(failing.limit)}` : holding.code}
      since {since}.{#if twapLag}
        spot agrees with the feed ({cell(spotVsOracle.reading)}): the pool twap lags a fast move. not
        manipulation.{/if}
    </p>
    <p class="blocked">blocked: {holding.blocks?.length ? holding.blocks.join(', ') : 'nothing due'}</p>
  </div>
{/if}

<style>
  .gates {
    width: 100%;
    table-layout: fixed;
  }

  .gates td,
  .gates th {
    white-space: pre;
    overflow: hidden;
    text-align: left;
  }

  .gate {
    width: 17ch;
  }

  .reading,
  .limit {
    width: 15ch;
  }

  .bar {
    width: 18ch;
  }

  .verdict {
    width: 10ch;
  }

  .saw {
    width: 7ch;
  }

  .off {
    color: var(--off);
  }

  .holding {
    border-top: 2px solid var(--frame);
    margin-top: 2px;
  }

  .holding p {
    margin: 0;
    max-width: 78ch;
  }

  .blocked {
    color: var(--muted);
  }
</style>
