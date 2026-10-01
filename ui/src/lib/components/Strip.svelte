<script>
  import { fmtPct, strip } from '../utils/text';

  // time in range as ▒ (in) / ░ (out) cells over the window
  export let flags = null;
  export let cells = 76;
  export let from = '';
  export let to = '';
  export let legend = true;
  export let compact = false;

  $: known = (flags ?? []).filter((f) => f != null);
  $: frac = known.length ? known.filter(Boolean).length / known.length : null;
</script>

{#if compact || !flags?.length}
  <span class="strip-num">in base {fmtPct(frac)}</span>
{:else}
  <span class="strip">{strip(flags, cells)}</span>
  {#if legend}
    <span class="legend"><span class="from">{from}</span><span class="mid">▒ in base   ░ out</span><span class="to">{to}</span></span>
  {/if}
{/if}

<style>
  .strip {
    display: block;
    white-space: pre;
    overflow: hidden;
    color: var(--bright);
  }

  .legend {
    display: flex;
    justify-content: space-between;
    color: var(--muted);
    white-space: nowrap;
  }
</style>
