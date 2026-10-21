// AVR Board & I/O webview. Plain JS, no build step. Messages: src/ui/protocol.ts.
// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const send = (m) => vscode.postMessage(m);
  const open = new Set(vscode.getState()?.open ?? ['PORTC', 'PORTD', 'PORTG']);
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

  function renderBoard() {
    const root = $('board');
    root.replaceChildren(...state.board.map((p) => {
      if (p.kind === 'ledBar') {
        // Index 0 is the bottom LED, so render top-down in reverse.
        return el('div', { class: 'card' }, el('h2', {}, 'LED bar'),
          el('div', { class: 'ledbar', role: 'list' }, ...p.leds.map((on, i) =>
            el('div', { class: 'led' + (on ? ' on' : ''), role: 'listitem', 'aria-label': `LED ${i} ${on ? 'on' : 'off'}` },
              el('span', {}, String(i)))).reverse()));
      }
      if (p.kind === 'buttons') {
        return el('div', { class: 'card' }, el('h2', {}, 'Push buttons'),
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
      return el('div', { class: 'card' }, el('h2', {}, p.label ?? p.kind));
    }));
  }

  function renderIo() {
    const root = $('io');
    const focused = document.activeElement?.id;
    root.replaceChildren(...state.io.map((g) => {
      const d = el('details', { open: open.has(g.name), ontoggle: () => {
        d.open ? open.add(g.name) : open.delete(g.name);
        vscode.setState({ open: [...open] });
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

  window.addEventListener('message', (e) => { state = e.data; render(); });
  send({ type: 'ready' });
  $('status').textContent = 'Waiting for an AVR debug session…';
})();
