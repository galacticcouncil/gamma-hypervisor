<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { theme, THEMES } from '../stores/theme';
  import { nav, showHelp, VIEWS, WINDOWS, hrefFor } from '../stores/keys';

  // menu order for Left/Right, and the Alt+letter hotkeys, Turbo Vision style
  const MENU_ORDER = ['sys', ...VIEWS.map((v) => v.id)];
  // w (window) and s (scheme) both land on the ≡ menu that hosts them
  const HOTKEYS = Object.fromEntries([
    ...VIEWS.map((v) => [v.hot.toLowerCase(), v.id]),
    ['w', 'sys'],
    ['s', 'sys'],
  ]);

  // hover-only dropdowns are unusable on touch, so they open on click now
  let openMenu = null;
  let navHeight = 0;
  let navEl;

  // the title clock is utc, like every timestamp on the screens
  let now = new Date();
  let clock;

  // the sticky table header parks itself right under the bar
  $: if (browser && navHeight) {
    document.documentElement.style.setProperty('--nav-h', `${navHeight}px`);
  }

  onMount(() => {
    clock = setInterval(() => (now = new Date()), 1000);
  });

  onDestroy(() => {
    if (clock) clearInterval(clock);
  });

  function utc(date) {
    return `${date.toISOString().slice(11, 19)} UTC`;
  }

  function toggleMenu(name) {
    openMenu = openMenu === name ? null : name;
  }

  function closeMenus() {
    if (browser && openMenu && navEl?.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    openMenu = null;
  }

  function run(action) {
    closeMenus();
    action();
  }

  // every navigation goes through the url; a drill with no vault to open is a no-op
  function go(view, extra) {
    const href = hrefFor(view, $nav, extra);
    if (href) goto(href);
  }

  // open a menu and put focus on its first item, so Up/Down work immediately
  async function openAndFocus(name) {
    openMenu = name;
    await tick();
    itemsOf(name)[0]?.focus();
  }

  function itemsOf(name) {
    if (!navEl) return [];
    return [
      ...navEl.querySelectorAll(
        `[data-menu="${name}"] button.tui-menu-item:not([disabled]), [data-menu="${name}"] a.tui-menu-item`
      ),
    ];
  }

  function onWindowKeydown(event) {
    // a dialog is on top — the menu must not open (or act) underneath it
    if ($showHelp) return;

    if (event.key === 'Escape') {
      closeMenus();
      return;
    }

    // F10 opens the menu, like every DOS program
    if (event.key === 'F10') {
      event.preventDefault();
      if (openMenu) closeMenus();
      else openAndFocus(MENU_ORDER[0]);
      return;
    }

    // Alt+highlighted letter jumps straight to a menu
    if (event.altKey && !event.ctrlKey && !event.metaKey && HOTKEYS[event.key?.toLowerCase?.()]) {
      event.preventDefault();
      openAndFocus(HOTKEYS[event.key.toLowerCase()]);
    }
  }

  // arrows inside an open menu: Up/Down move the bar, Left/Right hop menus
  function onNavKeydown(event) {
    if (!openMenu) return;

    const items = itemsOf(openMenu);
    const index = items.indexOf(document.activeElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const at = MENU_ORDER.indexOf(openMenu);
      openAndFocus(MENU_ORDER[(at + step + MENU_ORDER.length) % MENU_ORDER.length]);
    }
  }
</script>

<svelte:window on:keydown={onWindowKeydown} />

<!-- click anywhere else closes the open menu -->
{#if openMenu}
  <div class="menu-scrim" on:click={closeMenus} aria-hidden="true"></div>
{/if}

<nav class="tui-nav" bind:clientHeight={navHeight} bind:this={navEl} on:keydown={onNavKeydown}>
  <ul>
    <li class="tui-dropdown" class:open={openMenu === 'sys'}>
      <button
        class="menu-trigger"
        aria-haspopup="true"
        aria-expanded={openMenu === 'sys'}
        aria-label="System menu"
        on:click|stopPropagation={() => toggleMenu('sys')}
      >
        ≡
      </button>
      <div class="tui-dropdown-content" data-menu="sys">
        <ul>
          <li><span class="tui-menu-note">gamma keeper</span></li>
          <li><div class="tui-black-divider"></div></li>
          <li>
            <button class="tui-menu-item" on:click={() => run(() => showHelp.set(true))}>
              Help... <span class="right-key">F1</span>
            </button>
          </li>
          <li>
            <button class="tui-menu-item" on:click={() => run(() => window.open('/api/v1', '_blank'))}>
              /api/v1...
            </button>
          </li>
          <li>
            <button
              class="tui-menu-item"
              on:click={() => run(() => window.open('/api/v1/status.txt', '_blank'))}
            >
              /api/v1/status.txt...
            </button>
          </li>
          <li><div class="tui-black-divider"></div></li>
          <li><span class="tui-menu-note">window</span></li>
          {#each WINDOWS as w}
            <li>
              <button
                class="tui-menu-item"
                class:tui-menu-active={$nav.window === w}
                on:click={() => run(() => go($nav.view, { window: w }))}
              >
                {w} <span class="right-key">F8</span>
              </button>
            </li>
          {/each}
          <li><div class="tui-black-divider"></div></li>
          <li><span class="tui-menu-note">colours</span></li>
          {#each THEMES as scheme}
            <li>
              <button
                class="tui-menu-item"
                class:tui-menu-active={$theme === scheme.id}
                on:click={() => run(() => theme.set(scheme.id))}
              >
                {scheme.name}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </li>

    {#each VIEWS as view}
      <li class="tui-dropdown" class:open={openMenu === view.id}>
        <button
          class="menu-trigger"
          class:current={$nav.view === view.id}
          aria-haspopup="true"
          aria-expanded={openMenu === view.id}
          on:click|stopPropagation={() => toggleMenu(view.id)}
        >
          <span class="hot">{view.hot}</span>{view.label.slice(1)}
        </button>
        <div class="tui-dropdown-content" data-menu={view.id}>
          <ul>
            {#if view.id === 'vault'}
              <!-- one entry per vault, descriptor order; Enter on the fleet does the same -->
              {#if $nav.vaults.length === 0}
                <li><span class="tui-menu-note">no vaults yet</span></li>
              {/if}
              {#each $nav.vaults as v}
                <li>
                  <button
                    class="tui-menu-item"
                    class:tui-menu-active={$nav.vault === v.id && $nav.view !== 'fleet'}
                    on:click={() => run(() => go('vault', { vault: v.id }))}
                  >
                    {v.label}
                  </button>
                </li>
              {/each}
              <li><div class="tui-black-divider"></div></li>
              <li><span class="tui-menu-note">Tab / Shift+Tab: next / previous</span></li>
            {:else}
              <li>
                <button
                  class="tui-menu-item"
                  class:tui-menu-active={$nav.view === view.id}
                  on:click={() => run(() => go(view.id))}
                >
                  {view.label} <span class="right-key">{view.key}</span>
                </button>
              </li>
            {/if}
            {#if view.id === 'history'}
              <li><div class="tui-black-divider"></div></li>
              <li><span class="tui-menu-note">filter</span></li>
              {#each ['all', 'tx', 'skips', 'regime', 'errors', 'log'] as filter}
                <li>
                  <button
                    class="tui-menu-item"
                    on:click={() => run(() => go('history', { filter: filter === 'all' ? null : filter }))}
                  >
                    {filter}
                  </button>
                </li>
              {/each}
            {:else if view.id === 'econ'}
              <li><span class="tui-menu-note">F8 cycles the window</span></li>
            {:else if view.id === 'config'}
              <li>
                <button
                  class="tui-menu-item"
                  on:click={() => run(() => window.open('/api/v1/config', '_blank'))}
                >
                  /api/v1/config...
                </button>
              </li>
            {/if}
          </ul>
        </div>
      </li>
    {/each}

    <span class="tui-datetime clock">{utc(now)}</span>
  </ul>
</nav>

<style>
  /* tuicss opens dropdowns on :hover only — no touch, and no way to close one
     you opened. drive them from state instead. */
  .tui-dropdown > :global(.tui-dropdown-content) {
    display: none !important;
  }

  .tui-dropdown.open > :global(.tui-dropdown-content) {
    display: block !important;
  }

  /* one row, always. no overflow clip here — the dropdowns are absolutely
     positioned children and a clip would swallow them */
  nav > ul {
    display: flex;
    align-items: baseline;
    flex-wrap: nowrap;
    white-space: nowrap;
  }

  nav > ul > li {
    flex: none;
  }

  /* a long ≡ menu must not outgrow the screen */
  :global(.tui-dropdown-content) {
    max-height: calc(100vh - 60px);
    overflow-y: auto;
  }

  .menu-scrim {
    position: fixed;
    inset: 0;
    z-index: 8;
  }

  .menu-trigger,
  :global(.tui-dropdown-content .tui-menu-item) {
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .menu-trigger {
    padding: 0 6px;
  }

  /* the screen you are on is the active menu-bar entry */
  .menu-trigger.current {
    background-color: var(--active-bg);
    color: var(--active-text);
  }

  :global(.tui-dropdown-content .tui-menu-item) {
    width: 100%;
  }

  :global(.tui-dropdown-content a.tui-menu-item) {
    box-sizing: border-box;
    text-decoration: none;
  }

  .right-key {
    float: right;
    margin-left: 16px;
  }

  .clock {
    margin-left: auto;
    margin-right: 6px;
  }
</style>
