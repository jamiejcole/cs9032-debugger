// AVR Board & I/O webview. Plain JS, no build step. Messages: src/ui/protocol.ts.
// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const send = (m) => vscode.postMessage(m);
  const open = new Set(vscode.getState()?.open ?? ['PORTC', 'PORTD', 'PORTG']);
  /** Board cards the user collapsed; the rest start open. */
  const closed = new Set(vscode.getState()?.closed ?? []);
  const save = () => vscode.setState({ open: [...open], closed: [...closed] });
  let state = null;

  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids) e.append(k);
    return e;
  };
  const hex = (v, d = 2) => '0x' + v.toString(16).toUpperCase().padStart(d, '0');

  function render() {
    if (!state) return;
    if (state.type === 'ended') {
      $('status').textContent = 'No AVR debug session. Press F5 on an .asm file.';
      return;
    }
    const ms = (state.cycles / 16000).toFixed(3);
    $('status').textContent = `${state.running ? 'Running' : 'Paused'} · ${state.cycles} cycles · ${ms} ms`;
    renderBoard();
    renderIo();
  }

  /** A collapsible board card. Open/closed state is remembered like the I/O groups. */
  function card(id, title, ...kids) {
    const key = 'board:' + id;
    const d = el('details', { class: 'card', open: !closed.has(key), ontoggle: () => {
      if (d.open) closed.delete(key); else closed.add(key);
      save();
    } }, el('summary', {}, title));
    d.append(...kids);
    return d;
  }

  const svg = (tag, attrs = {}) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  /** A CG RAM character: 5x8 dots, one bit per dot, bit 4 on the left (manual Table 5.1). */
  function glyph(rows) {
    const g = svg('svg', { viewBox: '0 0 5 8', class: 'glyph', 'aria-hidden': 'true' });
    rows.forEach((bits, y) => { for (let x = 0; x < 5; x++) if ((bits >> (4 - x)) & 1) g.append(svg('rect', { x, y, width: 1, height: 1 })); });
    return g;
  }

  function renderLcd(p) {
    const grid = el('div', { class: 'lcd' + (p.backlight ? '' : ' nobl') + (p.on ? '' : ' off'), role: 'img',
      'aria-label': p.on ? p.lines.map((l) => l.trimEnd()).join(' / ') : 'LCD display off' });
    for (let row = 0; row < 2; row++) {
      const line = p.lines[row];
      const r = el('div', { class: 'lcdrow' });
      for (let col = 0; col < 16; col++) {
        const cur = p.cursor && p.cursor.row === row && p.cursor.col === col;
        const cell = el('span', { class: 'cell' + (cur && p.on ? (p.cursor.underline ? ' under' : '') + (p.cursor.blink ? ' blinkcur' : '') : '') });
        const c = p.custom.find((x) => x.row === row && x.col === col);
        if (p.on && c) cell.append(glyph(c.rows));
        else if (p.on && line) cell.append(line[col] === ' ' ? ' ' : line[col]);
        r.append(cell);
      }
      grid.append(r);
    }
    return card(p.id, 'LCD', grid);
  }

  function renderKeypad(p) {
    const grid = el('div', { class: 'keypad', role: 'group', 'aria-label': 'Keypad' });
    const toggle = (k) => send({ type: 'board', id: p.id, input: { kind: 'key', key: p.pressed === k ? null : k } });
    for (const row of p.keys) for (const k of row) {
      grid.append(el('button', {
        class: 'key' + (p.pressed === k ? ' down' : ''), 'aria-pressed': String(p.pressed === k),
        title: p.pressed === k ? 'Click to release' : 'Click to press and hold this key',
        onmousedown: (e) => { e.preventDefault(); toggle(k); },
        onkeydown: (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); toggle(k); } },
      }, k));
    }
    return card(p.id, 'Keypad', grid, el('div', { class: 'hint' }, p.pressed ? 'Holding ' + p.pressed + '. Click it again to release.' : 'Click a key to hold it.'));
  }

  function renderBoard() {
    const root = $('board');
    root.replaceChildren(...state.board.map((p) => {
      if (p.kind === 'ledBar') {
        // Index 0 is the bottom LED, so render top-down in reverse.
        return card(p.id, 'LED bar',
          el('div', { class: 'ledbar', role: 'list' }, ...p.leds.map((on, i) =>
            el('div', { class: 'led' + (on ? ' on' : ''), role: 'listitem', 'aria-label': `LED ${i} ${on ? 'on' : 'off'}` },
              el('span', {}, String(i)))).reverse()));
      }
      if (p.kind === 'buttons') {
        return card(p.id, 'Push buttons',
          ...p.buttons.map((b) => {
            const act = (action) => () => send({ type: 'board', id: p.id, input: { kind: 'button', name: b.name, action } });
            const press = el('button', {
              class: 'push' + (b.pressed ? ' down' : ''), 'aria-pressed': String(b.pressed), title: 'Hold to press',
              onmousedown: act('press'), onmouseup: act('release'), onmouseleave: b.pressed && !b.latched ? act('release') : null,
              onkeydown: (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); act('press')(); } },
              onkeyup: (e) => { if (e.key === ' ' || e.key === 'Enter') act('release')(); },
            }, b.name);
            const latch = el('label', { class: 'latch' },
              el('input', { type: 'checkbox', checked: b.latched, onchange: act('toggleLatch') }), ' latch');
            return el('div', { class: 'btnrow' }, press, latch);
          }));
      }
      if (p.kind === 'lcd') return renderLcd(p);
      if (p.kind === 'keypad') return renderKeypad(p);
      return card(p.id, p.label ?? p.kind);
    }));
  }

  function renderIo() {
    const root = $('io');
    const focused = document.activeElement?.id;
    root.replaceChildren(...state.io.map((g) => {
      const d = el('details', { open: open.has(g.name), ontoggle: () => {
        d.open ? open.add(g.name) : open.delete(g.name);
        save();
      } }, el('summary', {}, g.name));
      const table = el('table', { class: 'regs' });
      for (const r of g.regs) {
        const pinPort = /^PIN([A-L])$/.exec(r.name)?.[1];
        const cells = [];
        for (let b = 7; b >= 0; b--) {
          const on = (r.value >> b) & 1;
          const name = r.bits?.[7 - b] ?? `${r.name}${b}`;
          const pin = pinPort && `P${pinPort}${b}`;
          const driven = pin && state.pins[pin] !== undefined && state.pins[pin] !== 'z';
          const id = `bit-${r.name}-${b}`;
          cells.push(el('td', {}, el('button', {
            id, class: 'bit' + (on ? ' on' : '') + (driven ? ' driven' : ''),
            title: pin ? `${name} (${pin})${driven ? ', driven' : ''}. Click: drive opposite level. Shift+click: release.` : `${name}. Click to toggle.`,
            'aria-label': `${name} = ${on}`,
            onclick: (e) => {
              if (pin) send(e.shiftKey ? { type: 'releasePin', pin } : { type: 'togglePin', pin });
              else send({ type: 'writeIo', addr: r.addr, value: r.value ^ (1 << b) });
            },
          }, String(on))));
        }
        table.append(el('tr', {}, el('th', { scope: 'row' }, r.name), el('td', { class: 'val' }, hex(r.value)), ...cells));
      }
      d.append(table);
      return d;
    }));
    if (focused) document.getElementById(focused)?.focus();
  }

  // The LCD cursor blinks every 0.4 s (manual 3.1.4). A body class keeps the phase across re-renders.
  setInterval(() => document.body.classList.toggle('blink-off'), 400);

  window.addEventListener('message', (e) => { state = e.data; render(); });
  send({ type: 'ready' });
  $('status').textContent = 'Waiting for an AVR debug session…';
})();
