<script>
  import { tick } from 'svelte';
  import { browser } from '$app/environment';
  import { showHelp } from '../stores/keys';

  let okButton;

  // no arrows here: the DOS font has none (see server/contract/glyphs.ts)
  const KEYS = [
    ['Up/Down', 'move the cursor bar'],
    ['Enter', 'open the vault / expand a record'],
    ['Esc', 'back, or close the window / menu'],
    ['Tab, Shift+Tab', 'next / previous vault in a drill'],
    ['PgUp/PgDn', 'older / newer in history'],
    ['F1', 'this help'],
    ['F2', 'fleet'],
    ['F3', 'vault drill'],
    ['F4', 'gates'],
    ['F5', 'history'],
    ['F6', 'economics'],
    ['F7', 'config'],
    ['F8', 'window: 24h, 7d, 30d, launch'],
    ['F9', 'colour scheme'],
    ['F10, Alt+letter', 'menu'],
    ['r', 're-poll now'],
  ];

  async function open() {
    showHelp.set(true);
    await tick();
    okButton?.focus();
  }

  function close() {
    showHelp.set(false);
  }

  function onWindowKeydown(event) {
    if (event.key === 'F1') {
      event.preventDefault();
      if ($showHelp) close();
      else open();
    } else if (event.key === 'Escape' && $showHelp) {
      event.preventDefault();
      close();
    }
  }

  // focus < OK > when the dialog is opened from the menu too
  $: if (browser && $showHelp) {
    tick().then(() => okButton?.focus());
  }
</script>

<svelte:window on:keydown={onWindowKeydown} />

{#if $showHelp}
  <div class="overlay" on:click={close} aria-hidden="true"></div>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Help">
    <div class="frame">
      <p class="title">gamma keeper</p>
      <p class="about">
        Watches the gamma keeper: what it saw (keeper says), what the chain says now, and why it
        is or is not acting. Read-only; no key here writes anything.
      </p>

      <table class="keys">
        <tbody>
          {#each KEYS as [key, what]}
            <tr><td class="k">{key}</td><td>{what}</td></tr>
          {/each}
        </tbody>
      </table>

      <div class="buttons">
        <button bind:this={okButton} class="dos-btn" on:click={close}>&lt; OK &gt;</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* click-away target only — no dimming on a DOS desktop */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 120;
    background-color: transparent;
  }

  /* an MS-DOS EDIT dialog: gray, black text, double frame, dimmed shadow */
  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 121;
    background-color: var(--dialog-bg);
    color: var(--dialog-text);
    padding: 2px;
    box-shadow: 10px 8px 0 rgba(0, 0, 0, 0.55);
    max-width: 90vw;
  }

  .frame {
    border: 4px double var(--dialog-frame);
    padding: 8px 16px;
  }

  .title {
    margin: 0 0 8px 0;
    text-align: center;
  }

  .about {
    margin: 0 0 8px 0;
    max-width: 52ch;
  }

  .keys {
    border-collapse: collapse;
    margin: 0 auto 12px;
  }

  .keys td {
    padding: 0 8px;
  }

  .keys .k {
    color: var(--dialog-hot);
    text-align: right;
    white-space: nowrap;
  }

  .buttons {
    text-align: center;
  }

  .dos-btn {
    background: var(--dialog-bg);
    color: var(--dialog-text);
    border: none;
    font: inherit;
    cursor: pointer;
    padding: 0 4px;
  }

  .dos-btn:focus,
  .dos-btn:hover {
    background: var(--select-bg);
    color: var(--select-text);
    outline: none;
  }
</style>
