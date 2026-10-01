<script>
  import { bar, fmtPct } from '../utils/text';

  // reading/limit, uncapped; the bar caps at 100%. green pass, yellow >= 80%, red fail
  export let ratio = null;
  export let cells = 10;
  export let fail = null;
  export let pct = true;
  export let compact = false;
  export let off = false;

  $: cls = off ? 's-off' : fail ? 's-fault' : ratio != null && ratio >= 0.8 ? 's-held' : 's-success';
  $: text = ratio == null ? (off ? 'off' : 'n/a') : fmtPct(ratio, { digits: 0 });
</script>

{#if compact}
  <span class="bar {cls}">{text}</span>
{:else}
  <span class="bar {cls}">{bar(off ? null : ratio, cells)}</span>{#if pct}<span class="pct {cls}">{text}</span>{/if}
{/if}

<style>
  .bar {
    white-space: pre;
  }

  .pct {
    display: inline-block;
    min-width: 5ch;
    text-align: right;
    margin-left: 1ch;
  }
</style>
