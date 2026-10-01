<script>
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import FleetTable from '$lib/components/FleetTable.svelte';
  import Findings from '$lib/components/Findings.svelte';
  import { cols, seed, status, vaults } from '$lib/stores/status';
  import {
    ageOf,
    bar,
    envOf,
    fleetText,
    fmtAge,
    fmtBlock,
    fmtHuman,
    fmtNum,
    fmtWei,
    footerLines,
    shortAddr,
    weiToNumber,
  } from '$lib/utils/text';

  // the fleet: alive? in band? armed? blocking? gas? last act? for every vault in 3 seconds.
  // no raw wei on this screen — every cell links into the drill that explains it.
  export let data = {};

  const LIVE_CLS = {
    alive: 's-success',
    quiet: 's-success',
    due: 's-armed',
    'blocked-legit': 's-held',
    'blocked-operational': 's-fault',
    acting: 's-acting',
    stalled: 's-fault',
    unreachable: 's-off',
    restarted: 's-armed',
  };

  $: seed(data);

  let now = Date.now();
  let clock;

  $: agent = $page.url.searchParams.get('agent') === '1';
  $: env = envOf($page.url.hostname);
  $: k = $status?.keeper ?? null;
  $: n = $vaults.length;
  $: head = $status?.sources?.chain?.head ?? null;
  $: mon = $status?.sources?.monitor ?? null;
  $: gas = k?.gas ?? null;
  $: balance = weiToNumber(gas?.signerBalanceWei);
  $: warn = weiToNumber(gas?.warnWei);
  $: floor = weiToNumber(gas?.floorWei);
  $: gasCls = balance == null ? 's-off' : floor != null && balance <= floor ? 's-fault' : warn != null && balance <= warn ? 's-held' : 's-success';
  $: firing = ($status?.findings ?? []).filter((f) => f.active && f.source === 'monitor').length;
  $: agree = $vaults.filter((v) => (v.disagreements?.length ?? 0) === 0).length;
  $: footer = footerLines($status, now);
  $: wide = $cols >= 78;
  $: compact = $cols < 60;
  $: text = agent ? fleetText($status, { now, env }) : [];

  // the fleet row carries the slug, a finding row only the vault address
  function openVault(row) {
    const id = row?.slug || row?.id || row?.vault;
    if (id) goto(`/v/${id}`);
  }

  onMount(() => {
    if (!browser) return;
    clock = setInterval(() => (now = Date.now()), 1000);
  });

  onDestroy(() => {
    if (clock) clearInterval(clock);
  });
</script>

{#if agent}
  <pre class="agent-text">{text.join('\n')}</pre>
{:else}
  <div class="tui-panel fleet-panel">
    <div class="head">
      {#if k}
        <div class="line">
          <span class="s-off">gamma keeper</span>
          {#if wide}<span>{env}</span>{/if}
          <span>{n} vault{n === 1 ? '' : 's'}</span>
          {#if wide}<span class="s-off">signer</span><span>{shortAddr(k.signer)}</span>{/if}
          {#if k.mode === 'DRY_RUN'}
            <span class="dry" title="the keeper reports DRY_RUN: it evaluates and never sends">DRY</span>
          {:else}
            <span class="s-success">LIVE</span>
          {/if}
          {#if k.version}<span class="s-off">v{k.version}</span>{/if}
        </div>
        <div class="line">
          <span class="label {k.configured ? (LIVE_CLS[k.liveness] ?? 's-off') : 's-off'}">
            {k.configured ? k.liveness : 'not configured'}
          </span>
          <span>block {fmtBlock(k.head?.number)}</span>
          <span class="s-off">({fmtAge(k.head?.at ? ageOf(k.head.at, now) : null)})</span>
          {#if wide}
            <span>cycles {fmtNum(k.cyclesTotal)}</span>
            <span class={k.errorsTotal ? 's-fault' : 's-off'}>errors {fmtNum(k.errorsTotal)}</span>
            <span class="s-off">skipped {fmtNum(k.skippedWhileBusy)}</span>
          {/if}
          <span class="s-off">up {fmtAge(ageOf(k.bootAt, now))}</span>
        </div>
        <div class="line">
          <span class="label s-off">gas</span>
          <span class={gasCls}>{fmtWei(gas?.signerBalanceWei)}</span>
          {#if !compact}
            <span class={gasCls}>{bar(balance != null && warn ? balance / warn : null, 10)}</span>
          {/if}
          <span>runway {gas?.runwayDays != null ? Math.floor(gas.runwayDays) + 'd' : '-'}</span>
          {#if wide}
            <span class="s-off">warn {fmtHuman(warn)}</span>
            <span class="s-off">floor {fmtHuman(floor)}</span>
          {/if}
        </div>
        <div class="line">
          <span class="label s-off">chain</span>
          <span class={mon?.configured ? (mon.reachable ? '' : 's-stale') : 's-off'}>
            monitor {mon?.configured ? (mon.reachable ? fmtAge(mon.ageSecs) + ' ago' : 'unreachable') : 'not configured'}
          </span>
          <span class={firing ? 's-held' : 's-off'}>{firing} firing</span>
          <span class={agree === n ? 's-success' : 's-fault'}>agree {agree}/{n}</span>
          {#if wide}
            <span class={$status?.sources?.chain?.ok ? 's-off' : 's-stale'}>
              rpc #{fmtBlock(head?.number)} ({fmtAge(head?.at ? ageOf(head.at, now) : null)})
            </span>
          {/if}
        </div>
      {:else}
        <div class="line s-stale">gamma keeper {env} · connecting..</div>
      {/if}
    </div>

    <FleetTable vaults={$vaults} {now} {compact} {wide} showChain={$cols >= 100} on:open={(e) => openVault(e.detail)} />

    <div class="footer">
      <Findings rows={footer} on:open={(e) => openVault(e.detail)} />
    </div>
  </div>
{/if}

<style>
  .fleet-panel {
    display: block;
    width: 100%;
    padding: 0 1ch;
  }

  .head {
    padding: 0 0 2px 0;
  }

  .line {
    display: flex;
    gap: 2ch;
    white-space: pre;
    overflow: hidden;
  }

  .label {
    display: inline-block;
    min-width: 7ch;
  }

  .footer {
    border-top: 2px solid var(--frame);
    padding-top: 2px;
  }

  .agent-text {
    margin: 0;
    font: inherit;
    white-space: pre;
    color: var(--panel-text);
  }
</style>
