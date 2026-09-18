<script>
  import { createEventDispatcher, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { fmtBlock, fmtNum, fmtWei, fmtWhen, mapGlyphs, shortAddr, shortHash } from '../utils/text';

  // one expanded record: what the keeper decided, the plan it built, and the receipt it got.
  // mins are published only after landing, so `plan` is whatever the api carries.
  export let record = null;
  export let tx = null;
  export let now = undefined;

  const dispatch = createEventDispatcher();
  let okButton;

  function close() {
    dispatch('close');
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  $: cost = tx?.costWei ?? null;
  $: gasPrice = tx?.gasPriceWei ?? null;
  $: rows = record
    ? [
        ['when', `${fmtWhen(record.blockTs, now)}  block ${fmtBlock(record.block)}  seq ${fmtNum(record.seq)}`],
        ['outcome', `${record.outcome.code} (${record.outcome.stage})  ${mapGlyphs(record.outcome.detail ?? '')}`],
        ['winner', `${record.winner ?? '-'}${record.compoundDue ? '  +compound-due' : ''}`],
        [
          'reads',
          record.reads
            ? `spot ${record.reads.spotTick}  base [${record.reads.base.join(',')}]${record.reads.limit ? `  limit [${record.reads.limit.join(',')}]` : ''}`
            : '-',
        ],
        [
          'plan',
          record.plan
            ? `${record.plan.kind}  base [${record.plan.base.join(',')}]  limit [${record.plan.limit.join(',')}]  ${record.plan.side}  tol ${record.plan.tolBps}bps${record.plan.clamped ? '  clamped' : ''}`
            : 'not built',
        ],
        [
          'gate',
          record.gate
            ? `${record.gate.ok ? 'ok' : 'BLOCKED'}  ${mapGlyphs(record.gate.reason ?? '')}${record.gate.via ? `  (${record.gate.via})` : ''}`
            : '-',
        ],
        ['source', record.source],
      ]
    : [];
  $: txRows = tx
    ? [
        ['hash', shortHash(tx.hash)],
        ['kind', `${tx.kind}${tx.status === 0 ? '  REVERTED' : ''}`],
        ['from', shortAddr(tx.from)],
        [
          'cost',
          cost
            ? `${fmtWei(cost)}  (gas ${fmtNum(tx.gasUsed)} x ${gasPrice ? fmtWei(gasPrice, { symbol: '' }).trim() : '-'})${tx.costSource === 'estimate' ? '  estimated' : ''}`
            : '-',
        ],
        ['ticks', `base [${tx.base?.join(',') ?? '-'}]  limit [${tx.limit?.join(',') ?? '-'}]`],
        ['recipient', shortAddr(tx.feeRecipient)],
      ]
    : [];
  $: flags = tx?.flags ?? null;

  $: if (browser && record) {
    tick().then(() => okButton?.focus());
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if record}
  <div class="overlay" on:click={close} aria-hidden="true"></div>
  <div class="tui-window record" data-modal="1" role="dialog" aria-modal="true" aria-label="record">
    <div class="frame">
      <p class="title">{record.vault?.label ?? 'record'} · {record.outcome.code}</p>
      <table class="kv">
        <tbody>
          {#each rows as [k, v]}
            <tr><td class="k">{k}</td><td>{v}</td></tr>
          {/each}
          {#if tx}
            <tr><td class="k"> </td><td class="sep">--- receipt ---</td></tr>
            {#each txRows as [k, v]}
              <tr><td class="k">{k}</td><td>{v}</td></tr>
            {/each}
            {#if flags?.fullRange || flags?.foreignRecipient}
              <tr
                ><td class="k">flags</td><td class="s-error"
                  >{[flags.fullRange ? 'full-range' : null, flags.foreignRecipient ? 'foreign-recipient' : null]
                    .filter(Boolean)
                    .join('  ')}</td
                ></tr
              >
            {/if}
          {/if}
        </tbody>
      </table>
      <div class="buttons">
        <button bind:this={okButton} class="dos-btn" on:click={close}>&lt; Close &gt;</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 120;
    background-color: transparent;
  }

  .record {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 121;
    max-width: 92vw;
    max-height: 80vh;
    overflow: auto;
  }

  .frame {
    border: 4px double var(--window-frame);
    padding: 4px 12px;
  }

  .title {
    margin: 0 0 4px 0;
    text-align: center;
  }

  .kv {
    border-collapse: collapse;
  }

  .kv td {
    padding: 0 8px 0 0;
    white-space: pre-wrap;
    vertical-align: top;
  }

  .kv .k {
    color: var(--window-muted);
    text-align: right;
    white-space: nowrap;
  }

  .sep {
    color: var(--window-muted);
  }

  .buttons {
    text-align: center;
  }

  .dos-btn {
    background: none;
    color: inherit;
    border: none;
    font: inherit;
    cursor: pointer;
    padding: 0 4px;
  }

  .dos-btn:focus,
  .dos-btn:hover {
    background: var(--select-bg);
    color: var(--select-text);
    outline: none;
  }
</style>
