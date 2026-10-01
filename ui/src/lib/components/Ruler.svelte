<script>
  import { miniRuler, offMid, ruler } from '../utils/text';

  export let lower;
  export let upper;
  export let spot = null;
  export let twap = null;
  export let oracle = null;
  export let mid = null;
  export let limit = null;
  export let limitLiquidity = null;
  export let cells = 78;
  // the fleet cell: brackets are the band edges, no marker line
  export let mini = false;
  export let markers = true;
  // phones and ?agent=1: the number instead of the art
  export let compact = false;

  $: r = mini
    ? miniRuler({ lower, upper, spot, twap, oracle, cells })
    : ruler({ lower, upper, spot, twap, oracle, mid, limit, limitLiquidity, cells });
  $: at = r.line.indexOf('■');
  $: before = at >= 0 ? r.line.slice(0, at) : r.line;
  $: after = at >= 0 ? r.line.slice(at + 1) : '';
  $: spotCls = r.inBand ? 's-success' : 's-fault';
</script>

{#if compact || lower == null || upper == null}
  <span class="ruler num-only {spot != null && lower != null && spot >= lower && spot <= upper ? 's-success' : 's-fault'}"
    >{lower == null ? '-' : offMid({ lower, upper, spot })}</span
  >
{:else}
  <span class="ruler" class:mini>{before}{#if at >= 0}<span class={spotCls}>■</span>{after}{/if}</span>
  {#if !mini && markers}
    <span class="markers">{r.markers}</span>
  {/if}
{/if}

<style>
  .ruler,
  .markers {
    display: block;
    white-space: pre;
    overflow: hidden;
  }

  .ruler.mini,
  .num-only {
    display: inline;
  }

  .markers {
    color: var(--muted);
  }
</style>
