<script>
  import { bar } from '../utils/text';

  // `keeper says │ chain says`, row-aligned so a mismatch is visible. every row is one line;
  // below 78 cells the right column stacks under the left
  export let leftTitle = 'keeper says';
  export let rightTitle = 'chain says';
  // left rows: {label, value, cls, detail, bar: {ratio, text}}
  export let left = [];
  // right rows: {label, value, cls}
  export let right = [];
  export let compact = false;

  $: n = Math.max(left.length, right.length);
  $: rows = Array.from({ length: n }, (_, i) => ({ l: left[i] ?? null, r: right[i] ?? null }));
</script>

<div class="two" class:compact>
  <div class="col left">
    <div class="title">─── {leftTitle} ───</div>
    {#each rows as { l }}
      <div class="row">
        {#if l}
          <span class="label">{l.label}</span>
          <span class="value {l.cls ?? ''}">{l.value ?? ''}</span>
          {#if l.bar && !compact}
            <span class="bar {l.bar.cls ?? l.cls ?? ''}">{bar(l.bar.ratio, l.bar.cells ?? 8)} {l.bar.text ?? ''}</span>
          {:else if l.bar}
            <span class="bar {l.bar.cls ?? l.cls ?? ''}">{l.bar.text ?? ''}</span>
          {/if}
          <span class="detail {l.detailCls ?? ''}">{l.detail ?? ''}</span>
        {/if}
      </div>
    {/each}
  </div>
  <div class="col right">
    <div class="title">─── {rightTitle} ───</div>
    {#each rows as { r }}
      <div class="row">
        {#if r}
          <span class="label">{r.label}</span>
          <span class="value {r.cls ?? ''}">{r.value ?? ''}</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .two {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 22ch);
    column-gap: 0;
  }

  .col.right {
    border-left: 2px solid var(--frame);
    padding-left: 1ch;
  }

  .title {
    color: var(--head-text);
    white-space: nowrap;
    overflow: hidden;
  }

  .row {
    display: flex;
    gap: 1ch;
    white-space: pre;
    overflow: hidden;
    min-height: 1lh;
  }

  .label {
    flex: none;
    width: 8ch;
    color: var(--muted);
  }

  .value {
    flex: none;
    min-width: 8ch;
  }

  .right .value {
    min-width: 3ch;
    margin-left: auto;
  }

  .right .label {
    width: auto;
    color: var(--panel-text);
  }

  .detail {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: clip;
  }

  .bar {
    flex: none;
  }

  /* 60-77 cells: chain says stacks under keeper says */
  @media (max-width: 701px) {
    .two {
      grid-template-columns: minmax(0, 1fr);
    }

    .col.right {
      border-left: none;
      border-top: 2px solid var(--frame);
      padding-left: 0;
    }

    .right .value {
      margin-left: 0;
    }
  }
</style>
