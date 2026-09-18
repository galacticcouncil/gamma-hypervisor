<script context="module">
  // the wordmark as a 6-row pixel font folded into 3 text rows of half blocks. only ▀ ▄ █
  // and space come out of this, all of which the DOS font draws (server/contract/glyphs.ts)
  const PIXELS = [
    '.####. .###.. ##.##. ##.##. .###..',
    '#....# ....#. #.#.#. #.#.#. ....#.',
    '#....# .####. #.#.#. #.#.#. .####.',
    '.##### #...#. #...#. #...#. #...#.',
    '.....# #...#. #...#. #...#. #...#.',
    '.####. .####. #...#. #...#. .####.',
  ];

  function fold(px) {
    const rows = [];
    for (let r = 0; r < px.length; r += 2) {
      let s = '';
      for (let c = 0; c < px[r].length; c += 1) {
        const top = px[r][c] === '#';
        const bottom = px[r + 1]?.[c] === '#';
        s += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      }
      rows.push(s.replace(/\s+$/, ''));
    }
    return rows;
  }

  export const ROWS = fold(PIXELS);
</script>

<pre class="logo" aria-label="gamma">{ROWS.join('\n')}</pre>

<style>
  .logo {
    margin: 0;
    line-height: 1;
    color: var(--head-text);
    font: inherit;
    white-space: pre;
  }
</style>
