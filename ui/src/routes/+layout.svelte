<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import NavBar from '$lib/components/NavBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import HelpDialog from '$lib/components/HelpDialog.svelte';
  import { poll } from '$lib/services/api';
  import { apply, cols, dry, failed, loading, meta, seed, status, summary, vaultRefs } from '$lib/stores/status';
  import { hrefFor, nav, showHelp, siblingVault, stateFromUrl } from '$lib/stores/keys';
  import { envOf } from '$lib/utils/text';

  // the layout owns the chrome, the one /api/v1/status poll, and the keys no screen owns:
  // Tab/Shift+Tab (vault), Esc (back), r (re-poll). F-keys live in StatusBar, F10/Alt in
  // NavBar, F1 in HelpDialog.
  export let data = {};

  const POLL_MS = 5000;

  $: seed(data);
  // ?agent=1 renders art-free: no bars, no menu, no colour — just the 78-col text
  $: agent = $page.url.searchParams.get('agent') === '1';
  $: urlState = stateFromUrl($page.url);
  // the url segment may be the address; nav carries the label slug so Tab wraps in
  // descriptor order either way
  $: wanted = String(urlState.vault ?? '').toLowerCase();
  $: known = $vaultRefs.find((v) => v.id === wanted || v.address === wanted);
  $: nav.set({ ...urlState, vault: known?.id ?? urlState.vault, vaults: $vaultRefs });
  $: env = envOf($page.url.hostname);
  $: title = `gamma keeper${env ? ' ' + env : ''} · ${urlState.view}`;

  let poller = null;
  let probe;

  function repoll() {
    loading(true);
    poller?.now();
  }

  // cells, not pixels: one glyph is measured and the screen is sized in columns
  function measure() {
    if (!browser || !probe) return;
    const cell = probe.getBoundingClientRect().width / 10;
    if (cell > 0) cols.set(Math.max(20, Math.floor(window.innerWidth / cell)));
  }

  // an open menu or an expanded record takes the first Esc
  function overlayOpen() {
    return browser && !!document.querySelector('.tui-dropdown.open, [data-modal="1"]');
  }

  function onKeydown(event) {
    if (event.defaultPrevented || $showHelp) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === 'Tab' && $nav.view !== 'fleet') {
      const next = siblingVault($nav, event.shiftKey ? -1 : 1);
      const href = next ? hrefFor($nav.view, $nav, { vault: next }) : null;
      if (href) {
        event.preventDefault();
        goto(href);
      }
    } else if (event.key === 'Escape') {
      if (overlayOpen() || $nav.view === 'fleet') return;
      event.preventDefault();
      goto('/');
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      repoll();
    }
  }

  onMount(() => {
    measure();
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    poller = poll(
      '/api/v1/status',
      POLL_MS,
      (next) => apply(next),
      (e) => failed(e?.message ?? 'api unreachable'),
    );
    return () => poller?.stop();
  });
</script>

<svelte:window on:keydown={onKeydown} on:resize={measure} />
<svelte:head><title>{title}</title></svelte:head>

<span class="probe" bind:this={probe} aria-hidden="true">0000000000</span>

{#if agent}
  <main class="agent"><slot /></main>
{:else}
  <NavBar />
  <main class="screen">
    {#if $status == null}
      <div class="strip s-stale">api unreachable · retrying every {POLL_MS / 1000}s</div>
    {/if}
    <slot />
  </main>
  <StatusBar
    summary={$summary}
    lastRefreshTime={$meta.lastRefreshTime}
    pollMs={POLL_MS}
    loading={$meta.loading}
    sourceError={$meta.sourceError}
    dry={$dry}
  />
  <HelpDialog />
{/if}

<style>
  /* the nav and the status bar are fixed; the screen sits between them */
  .screen {
    padding: calc(var(--nav-h, 26px) + 6px) 6px 32px 6px;
  }

  .agent {
    padding: 0;
    color: var(--panel-text);
  }

  .strip {
    padding: 0 1ch;
    white-space: pre;
  }

  /* one cell, measured off-screen so `cols` is the real terminal width */
  .probe {
    position: absolute;
    top: -100px;
    left: -1000px;
    white-space: pre;
    visibility: hidden;
  }
</style>
