<script>
  import { createEventDispatcher } from 'svelte';
  import Ruler from './Ruler.svelte';
  import { showHelp } from '../stores/keys';
  import { fleetRows } from '../utils/text';

  // the norton-commander panel: one row per vault in descriptor order, a full-width cursor
  // bar, Up/Down to move it, Enter to open the drill. no key here writes anything.
  export let vaults = [];
  export let now = undefined;
  // >= 100 cols gains the chain column; < 78 drops blk and last; < 60 turns the band into a number
  export let showChain = false;
  export let wide = true;
  export let compact = false;
  export let cursor = 0;

  const dispatch = createEventDispatcher();
  const LEVEL = { ok: 's-success', held: 's-held', fault: 's-fault', unknown: 's-off' };

  $: rows = fleetRows({ vaults }, now);
  $: at = Math.min(Math.max(0, cursor), Math.max(0, rows.length - 1));

  // spot/twap/oracle for the band cell: the keeper's own gate reading first, the monitor's
  // snapshot when the keeper never evaluated it
  function band(v) {
    const c = v?.chain;
    if (!c) return null;
    const g = v.keeper?.gateSaw;
    const snap = v.monitor?.snapshot;
    return {
      lower: c.base.lower,
      upper: c.base.upper,
      spot: c.spotTick,
      twap: g?.twap?.tick ?? snap?.twapTick ?? null,
      oracle: g?.oracle?.tick ?? snap?.oracleTick ?? null,
    };
  }

  function open(i) {
    const row = rows[i];
    if (row) dispatch('open', row);
  }

  function onKeydown(event) {
    if (event.defaultPrevented || $showHelp || rows.length === 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = (at + 1) % rows.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = (at - 1 + rows.length) % rows.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(at);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if compact}
  <!-- phone: no columns left to drop, so every vault becomes two key/value lines -->
  <div class="list">
    {#each rows as row, i (row.id)}
      <div
        class="item"
        class:cursor={i === at}
        role="link"
        tabindex="0"
        on:click={() => {
          cursor = i;
          open(i);
        }}
        on:keydown={(e) => (e.key === 'Enter' ? open(i) : null)}
      >
        <div class="l">
          <span class="name">{row.label}</span>
          <span class={row.inBand ? 's-success' : 's-fault'}>{row.band}</span>
        </div>
        <div class="l s-off">
          <span class={row.armed !== '-' ? 's-armed' : ''}>{row.armed}</span>
          <span class={LEVEL[row.level] ?? ''}>{row.blocking}</span>
          <span>{row.last}</span>
        </div>
      </div>
    {:else}
      <div class="s-off">no vaults in the descriptor</div>
    {/each}
  </div>
{:else}
<table class="tui-table fleet">
  <thead>
    <tr>
      <th class="vault">vault</th>
      {#if wide}<th class="blk">blk</th>{/if}
      <th class="band">band</th>
      <th class="armed">armed</th>
      <th class="blocking">blocking</th>
      {#if wide}<th class="last">last</th>{/if}
      {#if showChain}<th class="chain">chain</th>{/if}
    </tr>
  </thead>
  <tbody>
    {#each rows as row, i (row.id)}
      {@const b = band(vaults[i])}
      <tr
        class:cursor={i === at}
        on:click={() => {
          cursor = i;
          open(i);
        }}
        on:mouseenter={() => (cursor = i)}
      >
        <td class="vault">{row.label}</td>
        {#if wide}<td class="blk {row.blk === 'err' ? 's-fault' : 's-success'}">{row.blk}</td>{/if}
        <td class="band">
          {#if b}
            <span class={row.inBand ? 's-success' : 's-fault'}>{row.inBand ? 'in ' : 'OUT'}</span><Ruler
              mini
              {compact}
              cells={12}
              lower={b.lower}
              upper={b.upper}
              spot={b.spot}
              twap={b.twap}
              oracle={b.oracle}
            />
          {:else}
            <span class="s-off">no sample</span>
          {/if}
        </td>
        <td class="armed" class:s-armed={row.armed !== '-'}>{row.armed}</td>
        <td class="blocking {LEVEL[row.level] ?? ''}">{row.blocking}</td>
        {#if wide}<td class="last">{row.last}</td>{/if}
        {#if showChain}<td class="chain">{row.chain}</td>{/if}
      </tr>
    {:else}
      <tr><td class="s-off" colspan="7">no vaults in the descriptor</td></tr>
    {/each}
  </tbody>
</table>
{/if}

<style>
  .list .item {
    cursor: pointer;
  }

  .list .item.cursor,
  .list .item:hover {
    background: var(--cursor-bg);
    color: var(--cursor-text);
  }

  .l {
    display: flex;
    gap: 1ch;
    white-space: pre;
    overflow: hidden;
  }

  .l .name {
    flex: 1 1 auto;
  }

  .fleet {
    width: 100%;
    table-layout: fixed;
  }

  .fleet td,
  .fleet th {
    white-space: pre;
    overflow: hidden;
    text-align: left;
  }

  .vault {
    width: 15ch;
  }

  .blk {
    width: 5ch;
  }

  .band {
    width: 19ch;
  }

  .armed {
    width: 12ch;
  }

  .blocking {
    width: 15ch;
  }

  .last,
  .chain {
    width: 10ch;
  }

  tbody tr {
    cursor: pointer;
  }
</style>
