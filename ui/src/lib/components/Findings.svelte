<script>
  import { createEventDispatcher } from 'svelte';

  // the fleet footer: active findings worst first, one quiet line per silent vault
  export let rows = [];

  const dispatch = createEventDispatcher();
  const CLS = { fault: 's-fault', held: 's-held', ok: 's-success', unknown: 's-off' };

  function open(row) {
    if (row.vault) dispatch('open', row);
  }
</script>

<div class="findings">
  {#each rows as row}
    <div
      class="row {CLS[row.cls] ?? ''}"
      class:stale={row.stale}
      class:link={!!row.vault}
      role={row.vault ? 'link' : undefined}
      tabindex={row.vault ? 0 : undefined}
      on:click={() => open(row)}
      on:keydown={(e) => (e.key === 'Enter' ? open(row) : null)}
    >
      <span class="mark">{row.mark}</span>
      <span class="label">{row.label}</span>
      <span class="text">{row.text}</span>
    </div>
  {:else}
    <div class="row s-off"><span class="mark"> </span><span class="label">-</span><span class="text">no findings</span></div>
  {/each}
</div>

<style>
  .row {
    display: flex;
    gap: 1ch;
    white-space: pre;
    overflow: hidden;
  }

  .row.link {
    cursor: pointer;
  }

  .row.link:hover,
  .row.link:focus {
    background: var(--cursor-bg);
    color: var(--cursor-text);
    outline: none;
  }

  .mark {
    flex: none;
    width: 1ch;
  }

  .label {
    flex: none;
    width: 13ch;
    overflow: hidden;
  }

  .text {
    flex: 1 1 auto;
    overflow: hidden;
  }

  .stale {
    color: var(--stale-color);
  }
</style>
