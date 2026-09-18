<script>
  import { ageOf, fmtAge, fmtClock, fmtNum, shortAddr } from '../utils/text';

  // the keeper's redacted /config beside the descriptor and the monitor's mirrored thresholds.
  // a row where the keeper and the descriptor disagree is a config-drift finding, in red.
  export let config = null;
  export let vault = null;
  export let now = undefined;
  export let compact = false;

  $: keeper = config?.keeper ?? null;
  $: kcfg = keeper?.config ?? null;
  $: id = vault?.id ?? null;
  $: vaultCfg = (kcfg?.vaults ?? []).find((v) => addr(v.VAULT) === id) ?? null;
  $: descriptor = (config?.descriptor?.vaults ?? []).find((v) => addr(v.VAULT) === id) ?? null;
  $: thresholds = config?.monitor?.thresholds?.[id] ?? config?.monitor?.thresholds?.[vault?.label] ?? null;
  $: drift = (config?.drift ?? []).filter((d) => d.vault == null || d.vault === id);
  $: drifted = new Set(drift.map((d) => d.key));
  $: keys = [...new Set([...Object.keys(vaultCfg ?? {}), ...Object.keys(descriptor ?? {}), ...Object.keys(thresholds ?? {})])].sort();
  $: globals = Object.entries(kcfg?.global ?? {}).sort(([a], [b]) => a.localeCompare(b));
  $: roles = vault?.chain?.roles ?? null;
  $: caps = vault?.chain?.caps ?? null;

  function addr(x) {
    return typeof x === 'string' ? x.toLowerCase() : null;
  }

  // urls arrive as {host}; everything else is a scalar the keeper's whitelist let through
  function val(v) {
    if (v == null) return '-';
    if (typeof v === 'object') return v.host ?? '-';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    const s = String(v);
    return /^0x[0-9a-fA-F]{40}$/.test(s) ? shortAddr(s) : s;
  }
</script>

<div class="line">
  <span class="label">keeper /config</span>
  <span class={keeper?.source === 'keeper' ? 's-success' : keeper?.source === 'cache' ? 's-stale' : 's-off'}
    >{keeper?.source ?? 'none'}</span
  >
  <span class="s-off">{keeper?.fetchedAt ? fmtAge(ageOf(keeper.fetchedAt, now)) + ' ago' : 'never'}</span>
  <span class="s-off">fingerprint {kcfg?.fingerprint ? kcfg.fingerprint.slice(0, 8) : '-'}</span>
  <span class="s-off">descriptor {config?.descriptor?.sha256 ? config.descriptor.sha256.slice(0, 8) : '-'}</span>
</div>

{#if drift.length}
  <div class="line s-fault">
    drift: {drift.length} key{drift.length === 1 ? '' : 's'} differ between the descriptor and what the keeper runs
  </div>
{/if}

<table class="tui-table cfg">
  <thead>
    <tr>
      <th class="key">key</th>
      <th>keeper</th>
      <th>descriptor</th>
      {#if !compact}<th>monitor</th>{/if}
    </tr>
  </thead>
  <tbody>
    {#each keys as key (key)}
      <tr class:drift={drifted.has(key)}>
        <td class="key">{key}</td>
        <td class={drifted.has(key) ? 's-fault' : ''}>{val(vaultCfg?.[key])}</td>
        <td class={drifted.has(key) ? 's-fault' : 's-off'}>{val(descriptor?.[key])}</td>
        {#if !compact}<td class="s-off">{val(thresholds?.[key])}</td>{/if}
      </tr>
    {:else}
      <tr><td class="s-off" colspan="4">no vault config yet</td></tr>
    {/each}
  </tbody>
</table>

<div class="block">
  <div class="line">
    <span class="label">roles</span>
    {#if roles}
      <span class={roles.rebalancerOk ? 's-success' : 's-fault'}>rebalancer {roles.rebalancerOk ? 'ok' : 'NO'}</span>
      <span class={roles.adminOk ? 's-success' : 's-fault'}>admin {roles.adminOk ? 'ok' : 'NO'}</span>
      <span class="s-off">exempted {roles.exempted ? 'yes' : 'no'}</span>
      {#if roles.deadlock}<span class="s-fault">DEADLOCK</span>{/if}
    {:else}
      <span class="s-off">not reported</span>
    {/if}
  </div>
  {#each roles?.warnings ?? [] as w}
    <div class="line s-held"><span class="label"> </span><span>{w}</span></div>
  {/each}
  <div class="line">
    <span class="label">caps</span>
    {#if caps}
      <span>translation {fmtNum(caps.maxTranslation)}</span>
      <span>width {fmtNum(caps.maxWidth)}</span>
      <span>min interval {fmtAge(caps.minIntervalSecs)}</span>
      <span class="s-off">last {caps.lastRebalanceTs ? fmtClock(caps.lastRebalanceTs) : '-'}</span>
    {:else}
      <span class="s-off">no proxy caps read</span>
    {/if}
  </div>
</div>

{#if !compact}
  <div class="block">
    <div class="line"><span class="label">global</span></div>
    <table class="tui-table cfg">
      <tbody>
        {#each globals as [key, v] (key)}
          <tr class:drift={drifted.has(key)}>
            <td class="key">{key}</td>
            <td class={drifted.has(key) ? 's-fault' : ''}>{val(v)}</td>
          </tr>
        {:else}
          <tr><td class="s-off" colspan="2">keeper /config not reachable</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .cfg {
    width: 100%;
    table-layout: fixed;
  }

  .cfg td,
  .cfg th {
    white-space: pre;
    overflow: hidden;
    text-align: left;
  }

  .key {
    width: 28ch;
  }

  .line {
    display: flex;
    gap: 2ch;
    white-space: pre;
    overflow: hidden;
  }

  .label {
    display: inline-block;
    min-width: 16ch;
    color: var(--muted);
  }

  .block {
    border-top: 2px solid var(--frame);
    margin-top: 2px;
    padding-top: 2px;
  }
</style>
