<script>
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { theme, THEMES } from '../stores/theme';
  import { nav, showHelp, VIEWS, hrefFor, nextWindow } from '../stores/keys';

  // what the page knows and the bar draws; the layout passes these from the status store
  export let summary = { quiet: 0, due: 0, blocked: 0 };
  export let lastRefreshTime = null;
  export let pollMs = 5000;
  export let loading = false;
  export let sourceError = '';
  export let dry = false;

  const SPINNER = '|/-\\';

  // Countdown to the next poll
  let countdown = '0.0';
  let overdue = false;
  let spin = '|';
  let countdownInterval;

  function updateCountdown() {
    if (!browser) return;

    const last = lastRefreshTime ? new Date(lastRefreshTime).getTime() : Date.now();
    const remainingMs = pollMs - (Date.now() - last);

    overdue = remainingMs <= 0;
    countdown = (Math.max(0, remainingMs) / 1000).toFixed(1);
    spin = SPINNER[Math.floor(Date.now() / 250) % 4];
  }

  $: onDrill = $nav.view !== 'fleet';

  function go(view, extra) {
    const href = hrefFor(view, $nav, extra);
    if (href) goto(href);
  }

  function cycleWindow() {
    go($nav.view === 'fleet' ? 'econ' : $nav.view, { window: nextWindow($nav.window) });
  }

  function cycleTheme() {
    const at = THEMES.findIndex((t) => t.id === $theme);
    theme.set(THEMES[(at + 1) % THEMES.length].id);
  }

  // the F-keys every DOS status bar promises: F2..F7 screens, F8 window, F9 scheme
  function onWindowKeydown(event) {
    if (event.defaultPrevented) return;
    // never navigate from under an open dialog
    if ($showHelp) return;

    const view = VIEWS.find((v) => v.key === event.key);
    if (view) {
      event.preventDefault();
      go(view.id);
    } else if (event.key === 'F8') {
      event.preventDefault();
      cycleWindow();
    } else if (event.key === 'F9') {
      event.preventDefault();
      cycleTheme();
    }
  }

  onMount(() => {
    if (browser) {
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 100);
    }
  });

  onDestroy(() => {
    if (browser && countdownInterval) {
      clearInterval(countdownInterval);
    }
  });
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div class="tui-statusbar">
  <ul>
    <li class="hide-small" on:click={() => showHelp.set(true)}>
      <span><span class="key">F1</span> Help</span>
    </li>
    {#each VIEWS as view}
      <!-- the screen you are on drops out of the bar, like the mockups -->
      {#if view.id !== $nav.view}
        <li class="hide-small" on:click={() => go(view.id)}>
          <span><span class="key">{view.key}</span> {view.short}</span>
        </li>
      {/if}
    {/each}
    {#if $nav.view === 'econ'}
      <li class="hide-small" on:click={cycleWindow}>
        <span><span class="key">F8</span> Window</span>
      </li>
    {/if}
    <li class="hide-small" on:click={cycleTheme}>
      <span><span class="key">F9</span> Theme</span>
    </li>
    {#if onDrill}
      <li class="hide-small"><span><span class="key">Tab</span> next vault</span></li>
      <li class="hide-small" on:click={() => go('fleet')}>
        <span><span class="key">Esc</span> back</span>
      </li>
    {:else}
      <li class="hide-small"><span><span class="key">F10</span> Menu</span></li>
    {/if}
    <span class="tui-statusbar-divider hide-small"></span>
    {#if dry}
      <li title="the keeper reports DRY_RUN: it evaluates and never sends">
        <span class="dry">DRY</span>
      </li>
      <span class="tui-statusbar-divider"></span>
    {/if}
    <li title="quiet / due / blocked" on:click={() => showHelp.set(true)}>
      <span>ok <span class="s-success">{summary.quiet}</span>/<span class="s-armed"
          >{summary.due}</span
        >/<span class="s-fault">{summary.blocked}</span></span
      >
    </li>
    <span class="tui-statusbar-divider"></span>
    <li>
      {#if sourceError}
        <span class="s-error">{sourceError}</span>
      {:else if loading}
        <span>{spin} polling</span>
      {:else if overdue}
        <span>{spin}<span class="hide-small"> waiting on poll</span></span>
      {:else}
        <span><span class="hide-small">next </span>{countdown}s</span>
      {/if}
    </li>
    <li class="parked" aria-hidden="true"><span class="blink">█</span></li>
  </ul>
</div>

<style>
  /* one row, always — clip instead of wrapping */
  .tui-statusbar ul {
    display: flex;
    align-items: baseline;
    flex-wrap: nowrap;
    overflow: hidden;
    white-space: nowrap;
  }

  .tui-statusbar ul li,
  .tui-statusbar ul .tui-statusbar-divider {
    flex: none;
  }

  li {
    cursor: pointer;
  }

  .parked {
    margin-left: auto;
    cursor: default;
  }

  @media (max-width: 600px) {
    .hide-small {
      display: none;
    }
  }
</style>
