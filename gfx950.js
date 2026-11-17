(() => {
  const byId = id => document.getElementById(id);
  const search = byId('isa-search');
  const groupFilter = byId('isa-group');
  const results = byId('isa-results');
  const count = byId('isa-result-count');
  const detail = byId('isa-detail');
  const mnemonic = byId('isa-mnemonic');
  const encodingSelect = byId('isa-encoding');
  const previous = byId('isa-previous');
  const next = byId('isa-next');
  const pageSize = 22;
  let matches = [];
  let page = 0;
  let active;

  const matrixLoads = {
    ds_read_b64_tr_b4: ['0–15, 32–47', '16–31, 48–63'],
    ds_read_b96_tr_b6: ['0–15, 32–47', '16–31, 48–63'],
    ds_read_b64_tr_b8: ['0–7, 16–23, 32–39, 48–55', '8–15, 24–31, 40–47, 56–63'],
    ds_read_b64_tr_b16: ['0–3, 8–11', '4–7, 12–15'],
  };

  function matrixKernelRole(name, subgroups) {
    if (subgroups.includes('MFMA')) return 'MFMA / SMFMAC';
    if (name in matrixLoads) return 'LDS transpose load';
    if (name.startsWith('v_accvgpr_')) return 'Accumulator move';
    if (/^(global|scratch)_load_lds_/.test(name)) return 'Direct-to-LDS load';
    if (/^v_cvt_.*(?:bf16|fp8|bf8|fp6|bf6|fp4)/.test(name)) return 'Low-precision conversion';
    if (/^v_dot[248]_/.test(name)) return 'Packed dot product';
    return '';
  }

  function el(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function link(href, label, external = false) {
    const node = el('a', '', label);
    node.href = href;
    if (external) {
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
    return node;
  }

  function hex(number) {
    return '0x' + number.toString(16);
  }

  const instructions = Object.entries(gfx950Isa).map(([name, row]) => {
    const [description, group, subgroups, aliases, encodings] = row;
    const role = matrixKernelRole(name, subgroups);
    const searchable = [
      name, ...aliases, role, group, ...subgroups,
      ...encodings.flatMap(([encoding, opcode]) => [encoding, hex(opcode)]),
    ].join(' ').toLowerCase();
    return { name, description, group, subgroups, aliases, encodings, role, searchable };
  });
  const groups = [...new Set(instructions.map(item => item.group))].sort();
  const groupNames = { MESSAGE: 'Message', TRAP: 'Trap', WAVE_CONTROL: 'Wave control' };
  for (const group of groups) groupFilter.add(new Option(groupNames[group] ?? group, group));
  byId('isa-total').textContent = `gfx950 · ${instructions.length.toLocaleString('en-US')} instructions · AMD XML 2026-02-20`;

  function renderList() {
    const first = page * pageSize;
    const last = Math.min(first + pageSize, matches.length);
    count.textContent = matches.length === 1 ? '1 match'
      : matches.length ? `${first + 1}–${last} of ${matches.length.toLocaleString('en-US')}` : '0 matches';
    const buttons = matches.slice(first, last).map(entry => {
      const row = el('li');
      const button = el('button', 'isa-instruction');
      button.type = 'button';
      button.dataset.mnemonic = entry.name;
      button.setAttribute('aria-pressed', String(entry === active));
      button.append(el('span', 'isa-name', entry.name), el('span', 'isa-tag', entry.role || entry.group));
      button.addEventListener('click', () => {
        active = entry;
        for (const row of results.querySelectorAll('button')) {
          row.setAttribute('aria-pressed', String(row === button));
        }
        renderDetail();
        if (window.matchMedia('(max-width: 1100px)').matches) mnemonic.focus();
      });
      row.append(button);
      return row;
    });
    results.replaceChildren(...buttons);
    if (!matches.length) results.append(el('li', 'isa-empty', 'No instructions match this search.'));
    previous.disabled = page === 0;
    next.disabled = last >= matches.length;
    byId('isa-pagination').hidden = matches.length <= pageSize;
  }

  function renderRelated(entry) {
    const section = byId('isa-related');
    section.replaceChildren();
    if (entry.subgroups.includes('MFMA')) {
      const query = new URLSearchParams({ arch: 'cdna4', instruction: entry.name });
      const viewer = link('index.html?' + query, 'Open lane and register layout →');
      viewer.className = 'control';
      section.append(viewer);
    } else if (entry.name in matrixLoads) {
      const [first, second] = matrixLoads[entry.name];
      section.append(
        el('h3', '', 'MFMA operand load'),
        el('p', '', 'Two loads with different LDS addresses and VGPR destinations assemble the tile.'),
        el('p', 'isa-secondary', `First load · K = ${first}\nSecond load · K = ${second}`),
        link('https://rocm-handbook.amd.com/projects/amd-rocm-optimization-guide/en/latest/compiler-builtins/cdna/cdna4-mfma-lds-builtins.html', 'LDS transpose load examples ↗', true),
      );
    }
    section.hidden = !section.childElementCount;
  }

  function renderDetail() {
    detail.hidden = !active;
    if (!active) return;
    mnemonic.textContent = active.name;
    byId('isa-family').textContent = [active.group, ...active.subgroups].join(' · ');
    byId('isa-description').textContent = active.description;
    const aliases = byId('isa-aliases');
    aliases.hidden = !active.aliases.length;
    aliases.textContent = active.aliases.length ? 'Aliases · ' + active.aliases.join(', ') : '';
    renderRelated(active);
    encodingSelect.replaceChildren(...active.encodings.map(([name, opcode, bits, condition], index) => {
      const modifier = condition === 'default' ? '' : ' · ' + condition;
      return new Option(`${name} · ${hex(opcode)} · ${bits} bits${modifier}`, index);
    }));
    encodingSelect.value = '0';
    renderOperands();
  }

  function renderOperands() {
    const [, , , , operands] = active.encodings[Number(encodingSelect.value)];
    const container = byId('isa-operands');
    if (!operands.length) {
      container.replaceChildren(el('p', 'muted', 'This encoding has no operands.'));
      return;
    }
    const table = el('table', 'isa-operands-table');
    const labels = ['Operand', 'Access', 'Type', 'Format', 'Size'];
    const head = table.createTHead().insertRow();
    for (const label of labels) {
      const th = el('th', '', label);
      th.scope = 'col';
      head.append(th);
    }
    const body = table.createTBody();
    const accessNames = { R: 'Read', W: 'Write', RW: 'Read/write' };
    for (const [field, access, type, format, size, implicit] of operands) {
      const row = body.insertRow();
      const values = [field || (implicit ? 'Implicit' : '—'), accessNames[access] ?? '—', type, format, size + ' bits'];
      for (const value of values) row.append(el('td', '', value));
    }
    container.replaceChildren(table);
  }

  function updateSearch() {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    matches = instructions.filter(entry => {
      const group = groupFilter.value;
      const inGroup = group === 'all' || (group === 'matrix-kernel' ? entry.role : entry.group === group);
      return inGroup && terms.every(term => entry.searchable.includes(term));
    });
    active = matches.find(entry => terms.length === 1 && [entry.name, ...entry.aliases].includes(terms[0]))
      ?? matches[0];
    page = active ? Math.floor(matches.indexOf(active) / pageSize) : 0;
    renderList();
    renderDetail();
  }

  function movePage(offset) {
    page += offset;
    if (!matches.slice(page * pageSize, (page + 1) * pageSize).includes(active)) {
      active = matches[page * pageSize];
      renderDetail();
    }
    renderList();
    const nextTarget = offset > 0 ? next : previous;
    if (nextTarget.disabled) results.querySelector('button')?.focus({ preventScroll: true });
  }

  previous.addEventListener('click', () => movePage(-1));
  next.addEventListener('click', () => movePage(1));
  search.addEventListener('input', updateSearch);
  groupFilter.addEventListener('change', updateSearch);
  encodingSelect.addEventListener('change', renderOperands);
  search.value = new URLSearchParams(location.search).get('instruction') ?? '';
  updateSearch();
})();
