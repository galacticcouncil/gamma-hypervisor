<script>
  import { createEventDispatcher } from 'svelte';
  import { showHelp } from '../stores/keys';
  import { fmtBlock, fmtNum, fmtWhen, hash4, mapGlyphs } from '../utils/text';

  // cycles, txs, regime changes and errors, newest first. hold cycles collapse to one row per
  // hour so a quiet day is a line, not 1,400. Enter expands the record that produced a tx.
  export let items = [];
  export let txs = [];
  export let filter = 'all';
  export let now = undefined;
  export let compact = false;
  export let pageSize = 18;

  const dispatch = createEventDispatcher();
  const CLS = {
    landed: 's-success',
    error: 's-fault',
    'gate-blocked': 's-held',
    cooldown: 's-held',
    'regime-extreme': 's-held',
    'no-regime-feed-unreadable': 's-held',
    arming: 's-armed',
    'compound-only': 's-armed',
    hold: 's-off',
    'gas-floor': 's-fault',
    'width-cap': 's-fault',
    'clamp-unworkable': 's-fault',
    'preflight-revert': 's-fault',
    'dry-run': 's-armed',
  };
  const SKIPS = new Set([
    'cooldown',
    'gate-blocked',
    'regime-extreme',
    'gas-floor',
    'width-cap',
    'clamp-unworkable',
    'preflight-revert',
    'no-regime-feed-unreadable',
  ]);

  let cursor = 0;
  let offset = 0;

  $: byHash = new Map((txs ?? []).map((t) => [t.hash?.toLowerCase(), t]));

  function keep(rec) {
    if (filter === 'tx') return !!rec.tx;
    if (filter === 'skips') return SKIPS.has(rec.outcome.code);
    if (filter === 'regime') return !!rec.regime?.changed;
    if (filter === 'errors') return rec.outcome.code === 'error';
    return true;
  }

  // consecutive holds inside one hour become `hold x1,412 cycles  drift 120-410`
  function collapse(list) {
    const out = [];
    let run = null;
    for (const it of list) {
      const rec = it.record;
      if (!rec || !keep(rec)) continue;
      const hour = Math.floor((rec.blockTs ?? 0) / 3600);
      const drift = rec.triggers?.rebalance?.drift ?? null;
      if (rec.outcome.code === 'hold' && run && run.hour === hour) {
        run.count += 1;
        if (drift != null) {
          run.lo = run.lo == null ? drift : Math.min(run.lo, drift);
          run.hi = run.hi == null ? drift : Math.max(run.hi, drift);
        }
        continue;
      }
      run =
        rec.outcome.code === 'hold'
          ? { hour, count: 1, lo: drift, hi: drift, item: it }
          : null;
      out.push(run ?? { hour, count: 1, lo: drift, hi: drift, item: it });
    }
    return out.map((r) => {
      const rec = r.item.record;
      const drift = r.lo != null && r.hi != null ? `  drift ${r.lo}-${r.hi}` : '';
      return {
        id: r.item.id ?? `${rec.bootAt}:${rec.seq}`,
        item: r.item,
        record: rec,
        when: fmtWhen(rec.blockTs, now),
        block: fmtBlock(rec.block),
        outcome: rec.outcome.code,
        cls: CLS[rec.outcome.code] ?? '',
        detail:
          r.count > 1
            ? `x${fmtNum(r.count)} cycles${drift}`
            : mapGlyphs(rec.outcome.detail ?? ''),
        tx: rec.tx ? hash4(rec.tx.hash) : '-',
        hash: rec.tx?.hash ?? null,
      };
    });
  }

  $: rows = collapse(items ?? []);
  $: pages = Math.max(1, Math.ceil(rows.length / pageSize));
  $: at = Math.min(offset, (pages - 1) * pageSize);
  $: shown = rows.slice(at, at + pageSize);
  $: cursor = Math.min(cursor, Math.max(0, shown.length - 1));

  function open(i) {
    const row = shown[i];
    if (!row) return;
    dispatch('open', { record: row.record, tx: row.hash ? (byHash.get(row.hash.toLowerCase()) ?? null) : null });
  }

  function onKeydown(event) {
    if (event.defaultPrevented || $showHelp || shown.length === 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, shown.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
    } else if (event.key === 'PageDown') {
      // older
      event.preventDefault();
      offset = Math.min(at + pageSize, (pages - 1) * pageSize);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      offset = Math.max(at - pageSize, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(cursor);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<table class="tui-table history">
  <thead>
    <tr>
      <th class="when">when</th>
      {#if !compact}<th class="block">block</th>{/if}
      <th class="outcome">outcome</th>
      <th class="detail">detail</th>
      <th class="tx">tx</th>
    </tr>
  </thead>
  <tbody>
    {#each shown as row, i (row.id)}
      <tr class:cursor={i === cursor} on:click={() => { cursor = i; open(i); }} on:mouseenter={() => (cursor = i)}>
        <td class="when">{row.when}</td>
        {#if !compact}<td class="block">{row.block}</td>{/if}
        <td class="outcome {row.cls}">{row.outcome}</td>
        <td class="detail">{row.detail}</td>
        <td class="tx">{row.tx}</td>
      </tr>
    {:else}
      <tr><td class="s-off" colspan="5">no records for this filter</td></tr>
    {/each}
  </tbody>
</table>

<div class="hint s-off">
  Enter: expand the record   F10 menu > History > filter   PgUp/PgDn: newer / older{pages > 1
    ? `   page ${Math.floor(at / pageSize) + 1}/${pages}`
    : ''}
</div>

<style>
  .history {
    width: 100%;
    table-layout: fixed;
  }

  .history td,
  .history th {
    white-space: pre;
    overflow: hidden;
    text-align: left;
  }

  .when {
    width: 13ch;
  }

  .block {
    width: 12ch;
  }

  .outcome {
    width: 15ch;
  }

  .tx {
    width: 6ch;
  }

  tbody tr {
    cursor: pointer;
  }

  .hint {
    border-top: 2px solid var(--frame);
    white-space: pre;
    overflow: hidden;
  }
</style>
