(() => {
  const { aliases, instructions, version } = amdInstructionData;
  const byId = id => document.getElementById(id);
  const architecture = byId('architecture');
  const instructionSelect = byId('instruction');
  const filter = byId('instruction-filter');
  const waveSelect = byId('wave');
  const blockSelect = byId('block');
  const registerTranspose = byId('register-transpose');
  const showLocations = byId('show-locations');
  const operands = byId('matrix-tabs');
  const modifiers = byId('modifiers');
  const rowInput = byId('query-row');
  const colInput = byId('query-col');
  const laneInput = byId('query-lane');
  const registerInput = byId('query-register');
  const lookupInputs = [rowInput, colInput, laneInput, registerInput];
  const panels = document.querySelector('.panels');
  const registerPanel = byId('register-panel');
  const registerScroll = byId('register-scroll');
  const selectionValue = byId('selection-value');
  const previewValue = byId('preview-value');
  const tracePanel = byId('trace');
  const traceContent = byId('trace-content');

  const chips = {
    cdna1: 'CDNA 1 · MI100',
    cdna2: 'CDNA 2 · MI200',
    cdna3: 'CDNA 3 · MI300',
    cdna4: 'CDNA 4 · MI350 (gfx950)',
    rdna3: 'RDNA 3 · gfx11',
    rdna4: 'RDNA 4 · gfx12',
  };
  const descriptions = {
    A: 'Input', B: 'Input', C: 'Accumulator', D: 'Output', K: 'Compression',
    Ax: 'A scale', Bx: 'B scale',
  };
  const axes = {
    A: ['i', 'k'], B: ['k', 'j'], C: ['i', 'j'], D: ['i', 'j'], K: ['i', 'k'],
    Ax: ['i', 'g'], Bx: ['g', 'j'],
  };
  const preferred = 'v_mfma_f32_16x16x16_f16';
  const selectionKey = 'amd-matrix-instruction-viewer.selection';
  let mnemonic;
  let instruction;
  let layout;
  let data;
  let matrix = 'D';
  let outputOperand = 'D';
  let mods = {};
  let selected = { type: 'element', row: 5, col: 7, block: 0 };
  let block = 0;
  let wave = 64;
  const matrixViews = new Map();
  const transposedMatrices = new Set();
  let registerCells = new Map();
  let registerTargets = new Map();
  let preview = null;
  let highlighted = [];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function option(value, label = value) {
    return new Option(label, value);
  }

  function coordinateKey(row, col) {
    return row + ',' + col;
  }

  function panelKey(operand) {
    return operand === 'C' ? 'D' : operand;
  }

  function activeEntries() {
    if (selected.type === 'element') {
      return [data.coordinates[selected.block][selected.row][selected.col]];
    }
    return selected.columns.flatMap(col =>
      data.byLocation.get(amdLayout.name({ ...col, lane: selected.lane }, true)) ?? []);
  }

  function pickElement(row, col, targetBlock = block, reveal = 'register') {
    const changedBlock = block !== targetBlock;
    block = targetBlock;
    selected = { type: 'element', row, col, block };
    if (changedBlock) {
      blockSelect.value = String(block);
      renderMatrices();
    }
    renderSelection(reveal);
  }

  function pickRegisters(lane, keys, reveal = 'matrix', laneOnly = false) {
    const columns = data.columns.filter(col => keys.includes(amdLayout.name(col)));
    if (columns.length === 0) return;
    selected = { type: 'register', lane, columns, laneOnly };
    const entries = activeEntries();
    if (entries.length && !entries.some(entry => entry.block === block)) {
      block = entries[0].block;
      blockSelect.value = String(block);
      renderMatrices();
    }
    renderSelection(reveal);
    if (reveal === 'matrix') revealMatrixSelection();
  }

  function fillArchitectures() {
    architecture.replaceChildren(...Object.entries(chips).map(([arch, label]) => {
      const item = option(arch, label);
      item.title = Object.keys(aliases).filter(alias => aliases[alias] === arch).join(', ');
      return item;
    }));
    architecture.value = 'cdna3';
  }

  function validInstructionSelection(choice) {
    return choice && Object.hasOwn(instructions, choice.arch)
      && Object.hasOwn(instructions[choice.arch], choice.mnemonic);
  }

  function initialInstructionSelection() {
    const current = history.state?.instructionSelection;
    if (validInstructionSelection(current)) return current;

    const query = new URLSearchParams(location.search);
    if (query.has('arch') || query.has('instruction')) {
      return {
        arch: aliases[query.get('arch')?.toLowerCase()],
        mnemonic: query.get('instruction')?.toLowerCase(),
      };
    }

    try {
      const saved = JSON.parse(localStorage.getItem(selectionKey));
      if (validInstructionSelection(saved)) return saved;
    } catch {
      // Some browsers disable storage for local files.
    }
    return {};
  }

  function rememberInstructionSelection() {
    const selection = selected.type === 'register'
      ? { type: 'register', lane: selected.lane, laneOnly: selected.laneOnly, registers: selected.columns.map(col => amdLayout.name(col)) }
      : { type: 'element', row: selected.row, col: selected.col };
    const lookup = Object.fromEntries(lookupInputs.map(input => [input.id, input.value]));
    const choice = { arch: architecture.value, mnemonic, matrix, outputOperand, wave, block, mods, selection, lookup };
    try {
      history.replaceState({ ...history.state, instructionSelection: choice }, '');
    } catch {
      // Browsers may limit history writes during rapid filtering.
    }
    try {
      localStorage.setItem(selectionKey, JSON.stringify(choice));
    } catch {
      // The current history entry can still retain the selection.
    }
  }

  function fillInstructions(desired) {
    const arch = architecture.value;
    const names = Object.keys(instructions[arch]);
    const query = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = names.filter(name => {
      const { m, n, k, in_type, in_type_src1, out_type } = instructions[arch][name];
      const searchable = [name, `${m}x${n}x${k}`, in_type, in_type_src1, out_type].join(' ');
      return query.every(part => searchable.includes(part));
    });
    byId('filter-status').hidden = matches.length > 0;
    if (!matches.length) {
      const current = desired && names.includes(desired) ? desired : names[0];
      instructionSelect.replaceChildren(option(current));
      instructionSelect.value = current;
      filter.setAttribute('aria-invalid', 'true');
      return;
    }
    filter.removeAttribute('aria-invalid');
    instructionSelect.replaceChildren(...matches.map(name => option(name)));
    instructionSelect.value = matches.includes(desired) ? desired : matches[0];
  }

  function configureInstruction(saved = {}) {
    mnemonic = instructionSelect.value;
    instruction = instructions[architecture.value][mnemonic];
    const supportedWaves = instruction.arch.startsWith('cdna') ? [64] : [32, 64];
    wave = supportedWaves.includes(saved.wave) ? saved.wave : supportedWaves[0];
    waveSelect.replaceChildren(...supportedWaves.map(size => option(size, 'wave' + size)));
    waveSelect.value = String(wave);
    mods = { ...saved.mods };
    configureModifiers();
    const supportedMatrices = amdLayout.matrices(instruction);
    matrix = saved.matrix ?? matrix;
    if (!supportedMatrices.includes(matrix)) matrix = 'D';
    if (matrix === 'C' || matrix === 'D') outputOperand = matrix;
    else if (saved.outputOperand === 'C' && supportedMatrices.includes('C')) outputOperand = 'C';
    block = Number.isInteger(saved.block) && saved.block >= 0 && saved.block < instruction.blocks ? saved.block : 0;
    configureBlocks();
    const [rows, cols] = amdLayout.dimensions(instruction, matrix);
    const coordinate = saved.selection?.type === 'element' ? saved.selection : selected;
    const clamp = (value, size) => Number.isInteger(value) ? Math.max(0, Math.min(value, size - 1)) : 0;
    selected = { type: 'element', row: clamp(coordinate.row, rows), col: clamp(coordinate.col, cols), block };
    renderOverview();
    rebuild('register', saved);
  }

  function configureBlocks() {
    blockSelect.replaceChildren(...Array.from({ length: instruction.blocks }, (_, idx) => option(idx)));
    blockSelect.value = String(block);
    byId('block-control').hidden = instruction.blocks === 1;
  }

  function configureModifiers() {
    const previous = mods;
    const definitions = amdLayout.modifierOptions(instruction, wave, previous.cbsz);
    mods = {};
    const fields = definitions.map(([key, label, values]) => {
      const allowed = Array.isArray(values) ? values : Array.from({ length: values + 1 }, (_, idx) => idx);
      mods[key] = allowed.includes(previous[key]) ? previous[key] : 0;
      const wrapper = el('label', 'field', label);
      const select = el('select');
      select.id = 'modifier-' + key;
      const isFormat = key === 'aFormat' || key === 'bFormat';
      select.replaceChildren(...allowed.map(value => option(value, isFormat ? amdCdna4.formatLabels[value] : value)));
      select.value = String(mods[key]);
      select.addEventListener('change', () => {
        mods[key] = Number(select.value);
        if (key === 'cbsz') {
          configureModifiers();
          byId('modifier-cbsz').focus();
        }
        if (instruction.arch === 'cdna4') renderOverview();
        rebuild();
      });
      wrapper.append(select);
      return wrapper;
    });
    modifiers.replaceChildren(...fields);
    const notes = [];
    if (instruction.cbsz_abid) {
      notes.push(instruction.sparse ? 'CBSZ / ABID select the A compression index set.' : 'CBSZ / ABID broadcast blocks of A.');
    }
    if (instruction.blgp) {
      notes.push(instruction.in_type === 'fp64' ? 'BLGP controls the signs of A, B, and C.' : 'BLGP remaps B lanes.');
    }
    if (instruction.cd_opsel) {
      notes.push('OPSEL selects the high or low half of the C and D registers.');
    } else if (instruction.sparse && instruction.arch === 'rdna4') {
      notes.push('OPSEL selects the A compression index set.');
    }
    if (instruction.neg) {
      notes.push(instruction.integer ? 'NEG selects signed interpretation for A and B.' : 'NEG / NEG_HI control input signs and the absolute value of C.');
    }
    if (instruction.mixed) {
      notes.push('A and B select their input formats independently.');
    }
    if (instruction.scaled) {
      notes.push('Each Ax or Bx byte holds an E8M0 scale for a group of 32 K values.');
    }
    byId('modifier-note').textContent = notes.join(' ') || 'This instruction has no supported modifiers.';
  }

  function renderOverview() {
    const { m, n, k, opcode, cycles, in_type, in_type_src1, out_type, sparse, blocks } = instruction;
    const cdna4 = instruction.arch === 'cdna4';
    byId('mnemonic').textContent = mnemonic;
    const formatType = key => key.replace(/^amd_/, '').toUpperCase();
    const input = (cdna4 ? amdCdna4.dataTypes(instruction, mods) : [in_type, in_type_src1]).map(formatType);
    const types = `${input[0] === input[1] ? input[0] : input.join(' / ')} → ${formatType(out_type)}`;
    const stats = [
      ['Tile · M × N × K', `${m} × ${n} × ${k}`],
      ['Data types · A/B → D', types],
      ['Execution cycles', cdna4 ? amdCdna4.cycles(instruction, mods) : cycles],
      ['VOP3P opcode', '0x' + opcode.toString(16)],
      ['Operation', sparse ? '4:2 sparse' : instruction.scaled ? 'Block scaled' : blocks > 1 ? `${blocks} blocks` : 'Dense'],
    ];
    byId('instruction-stats').replaceChildren(...stats.map(([key, value]) => {
      const stat = el('div');
      stat.append(el('dt', '', key), el('dd', '', value));
      return stat;
    }));
    byId('detail-text').textContent = cdna4 ? amdCdna4.details(mnemonic, instruction, mods) : instruction.detail;
    byId('encoding-reference').href = cdna4 ? amdCdna4.isa
      : 'https://github.com/ROCm/amd_matrix_instruction_calculator/blob/main/README.md#details-of-amd-matrix-multiplication-instruction-encodings';
    byId('source-version').textContent = cdna4 ? 'AMD CDNA 4 ISA · Chapter 7' : 'AMD Matrix Instruction Calculator v' + version;
  }

  function useMatrix(value, entry = null) {
    const old = selected;
    const oldBlock = block;
    matrix = value;
    if (value === 'C' || value === 'D') outputOperand = value;
    const [rows, cols] = amdLayout.dimensions(instruction, matrix);
    if (entry) block = entry.block;
    selected = {
      type: 'element',
      row: entry?.row ?? Math.min(old.row ?? 0, rows - 1),
      col: entry?.col ?? Math.min(old.col ?? 0, cols - 1),
      block,
    };
    blockSelect.value = String(block);
    if (block !== oldBlock) {
      renderMatrices();
    } else {
      const outputView = matrixViews.get('D');
      if (outputView.operand !== outputOperand) {
        outputView.operand = outputOperand;
        updateOutputToggle(outputView);
        renderMatrix('D', outputView);
      }
    }
    renderActiveOperand('register');
  }

  function renderTabs() {
    operands.replaceChildren(...amdLayout.matrices(instruction).map(value => {
      const button = el('button', 'matrix-tab');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(value === matrix));
      button.setAttribute('aria-label', value + ' · ' + descriptions[value]);
      button.append(el('b', '', value), el('span', '', descriptions[value]));
      button.addEventListener('click', () => {
        useMatrix(value);
        operands.querySelector('[aria-pressed="true"]').focus();
        revealMatrixSelection();
      });
      return button;
    }));
  }

  function rebuild(reveal, saved) {
    layout = amdLayout.create(instruction, wave, mods);
    renderMatrices();
    renderActiveOperand(reveal, saved);
  }

  function renderActiveOperand(reveal, saved) {
    data = layout.table(matrix);
    if (selected.type === 'register') {
      const keys = selected.columns.map(col => amdLayout.name(col));
      const columns = data.columns.filter(col => keys.includes(amdLayout.name(col)));
      selected = columns.length ? { ...selected, lane: Math.min(selected.lane, wave - 1), columns }
        : { type: 'element', row: 0, col: 0, block };
    } else if (saved?.selection?.type === 'register') {
      const { lane, laneOnly, registers } = saved.selection;
      if (Number.isInteger(lane) && lane >= 0 && lane < wave && Array.isArray(registers)) {
        const columns = data.columns.filter(col => registers.includes(amdLayout.name(col)));
        if (columns.length) selected = { type: 'register', lane, columns, laneOnly: laneOnly === true };
      }
    }
    const [rows, cols] = amdLayout.dimensions(instruction, matrix);
    rowInput.max = String(rows - 1);
    colInput.max = String(cols - 1);
    laneInput.max = String(wave - 1);
    byId('row-label').textContent = 'Row · ' + axes[matrix][0];
    byId('col-label').textContent = 'Column · ' + axes[matrix][1];
    fillRegisterInput();
    for (const [key, view] of matrixViews) {
      view.panel.classList.toggle('active-operand', key === panelKey(matrix));
    }
    byId('register-subtitle').textContent = `Matrix ${matrix} · wave${wave} · ${data.columns.length} register slots`;
    renderTabs();
    renderRegisters();
    renderSelection(reveal, saved?.lookup);
  }

  function fillRegisterInput() {
    const options = [];
    const physical = new Set();
    for (const location of data.columns) {
      const key = amdLayout.name(location);
      options.push(option(key));
      for (let reg = location.reg; reg < location.reg + location.count; reg++) {
        if (location.count !== 1 || location.low !== undefined) physical.add(reg);
      }
    }
    options.push(...[...physical].map(reg => option('physical:' + reg, 'v' + reg + ' · all bits')));
    registerInput.replaceChildren(...options);
  }

  function makeTable(header, lines, corner) {
    const top = el('thead');
    const heading = el('tr');
    heading.append(el('th', '', corner));
    for (const item of header) heading.append(item);
    top.append(heading);
    const body = el('tbody');
    for (const { label, cells } of lines) {
      const line = el('tr');
      line.append(label, ...cells);
      body.append(line);
    }
    const table = el('table', 'layout-table');
    table.append(top, body);
    return table;
  }

  function heading(text, click, label, scope = 'col', target) {
    const cell = el('th');
    cell.scope = scope;
    if (click) {
      const button = el('button', '', text);
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.addEventListener('click', click);
      if (target) registerTargets.set(button, target);
      cell.append(button);
    } else {
      cell.textContent = text;
    }
    return cell;
  }

  function renderMatrices() {
    for (const view of matrixViews.values()) view.panel.remove();
    matrixViews.clear();
    const keys = amdLayout.matrices(instruction).filter(value => value !== 'C');
    if (instruction.sparse) keys.splice(2, 2, 'D', 'K');
    for (const key of keys) {
      const sharedOutput = key === 'D' && !instruction.sparse;
      const operand = sharedOutput ? outputOperand : key;
      const panel = byId('matrix-panel-template').content.firstElementChild.cloneNode(true);
      const title = panel.querySelector('h2');
      title.id = 'matrix-title-' + key;
      title.textContent = sharedOutput ? 'Matrix C / D' : 'Matrix ' + operand;
      panel.setAttribute('aria-labelledby', title.id);
      panel.classList.toggle('active-operand', key === panelKey(matrix));
      const grid = panel.querySelector('.matrix-grid');
      grid.id = 'matrix-grid-' + key;
      const scrollbar = panel.querySelector('.matrix-scrollbar');
      scrollbar.setAttribute('aria-label', 'Scroll ' + title.textContent + ' horizontally');
      scrollbar.setAttribute('aria-controls', grid.id);
      scrollbar.addEventListener('input', () => { grid.scrollLeft = scrollbar.valueAsNumber; });
      grid.addEventListener('scroll', () => { scrollbar.value = String(Math.round(grid.scrollLeft)); });
      const view = { panel, grid, scrollbar, operand, cells: new Map(), targets: new Map() };
      matrixViews.set(key, view);
      panels.insertBefore(panel, registerPanel);
      const transpose = panel.querySelector('.matrix-transpose');
      transpose.checked = transposedMatrices.has(key);
      transpose.setAttribute('aria-label', 'Transpose ' + title.textContent);
      transpose.addEventListener('change', () => {
        if (transpose.checked) transposedMatrices.add(key);
        else transposedMatrices.delete(key);
        renderMatrix(key, view);
        setPreview(null);
        setHighlights();
      });
      if (sharedOutput) {
        panel.querySelector('.output-toggle').hidden = false;
        for (const button of panel.querySelectorAll('[data-output]')) {
          button.addEventListener('click', () => useMatrix(button.dataset.output));
        }
        updateOutputToggle(view);
      }
      setupExport(panel.querySelector('.export-options'), 'matrix', () => view.operand);
      renderMatrix(key, view);
    }
  }

  function updateOutputToggle(view) {
    for (const button of view.panel.querySelectorAll('[data-output]')) {
      button.setAttribute('aria-pressed', String(button.dataset.output === view.operand));
    }
  }

  function updateMatrixScrollbar({ grid, scrollbar }) {
    const max = grid.scrollWidth - grid.clientWidth;
    scrollbar.max = String(max);
    scrollbar.value = String(Math.round(grid.scrollLeft));
    scrollbar.hidden = max <= 0;
  }

  function renderMatrix(key, view) {
    const value = view.operand;
    const tile = layout.table(value).coordinates[block];
    const transposed = transposedMatrices.has(key);
    const cells = transposed ? amdExports.transpose(tile) : tile;
    const axisNames = transposed ? [...axes[value]].reverse() : axes[value];
    const columnCount = cells[0].length;
    view.grid.classList.toggle('show-full-locations', showLocations.checked);
    view.panel.querySelector('.panel-heading p').textContent = `${descriptions[value]} · ${cells.length} × ${columnCount}`;
    view.cells.clear();
    view.targets.clear();

    function renderCell(entry) {
      const cell = el('td', 'matrix-cell');
      const [location] = entry.locations;
      const fullLabels = entry.locations.map(loc => layout.decorate(amdLayout.name(loc, true), value, loc));
      const button = el('button');
      button.type = 'button';
      button.setAttribute('aria-label', entry.label);
      button.setAttribute('aria-description', fullLabels.join(', '));
      button.title = entry.label + ' → ' + fullLabels.join(', ');
      if (showLocations.checked) {
        const locations = el('span', 'full-location');
        locations.append(...fullLabels.map(label => el('span', '', label)));
        button.append(locations);
      } else {
        const tags = el('span', 'location-tags');
        const lane = el('span', 'lane-tag', 'T' + location.lane);
        const laneCopies = new Set(entry.locations.map(item => item.lane)).size - 1;
        if (laneCopies) {
          lane.append(el('sup', 'lane-copies', '+' + laneCopies));
        }
        const reg = [...new Set(entry.locations.map(item =>
          layout.decorate(amdLayout.name(item).split('.')[0], value, item)))].join('+');
        tags.append(lane, el('span', 'register-tag', reg));
        button.append(tags);
      }
      button.addEventListener('click', () => {
        if (value === matrix) pickElement(entry.row, entry.col, block, 'register');
        else useMatrix(value, entry);
      });
      view.cells.set(coordinateKey(entry.row, entry.col), { button, entry });
      view.targets.set(button, { entry });
      cell.append(button);
      return cell;
    }

    const headers = cells[0].map((_, col) => heading(String(col)));
    const lines = cells.map((line, row) => ({
      label: heading(String(row), null, null, 'row'),
      cells: line.map(renderCell),
    }));
    const table = makeTable(headers, lines, axisNames.join('\\'));
    table.style.setProperty('--matrix-columns', columnCount);
    table.setAttribute('aria-label', 'Matrix ' + value);
    view.grid.replaceChildren(table);
    updateMatrixScrollbar(view);
  }

  function renderRegisters() {
    const transposed = registerTranspose.checked;
    const lanes = Array.from({ length: wave }, (_, lane) => lane);
    const names = data.columns.map(location => amdLayout.name(location));
    registerCells = new Map();
    registerTargets = new Map();
    const laneHeader = (lane, scope) => heading('T' + lane, () => pickRegisters(lane, names, 'matrix', true),
      'Select lane ' + lane, scope, { lane });
    const registerHeader = (reg, scope) => {
      const label = amdLayout.name(reg);
      return heading(label, () => {
        const lane = laneInput.validity.valid ? laneInput.valueAsNumber : 0;
        pickRegisters(lane, [label]);
      }, 'Select register ' + label, scope, { register: reg });
    };

    function cell(lane, reg) {
      const key = amdLayout.name({ ...reg, lane }, true);
      const entries = data.byLocation.get(key) ?? [];
      const td = el('td', 'register-cell');
      const button = el('button', entries.length ? '' : 'empty');
      button.type = 'button';
      button.title = key;
      button.setAttribute('aria-label', key + (entries.length ? ' · ' + entries.map(entry => entry.label).join(', ') : ' · empty'));
      if (!entries.length) button.textContent = '–';
      for (const entry of entries) button.append(el('span', '', layout.decorate(entry.label, matrix, reg)));
      button.addEventListener('click', () => pickRegisters(lane, [amdLayout.name(reg)]));
      const location = { ...reg, lane };
      registerCells.set(key, { button, location });
      registerTargets.set(button, { location });
      td.append(button);
      return td;
    }

    const headers = transposed ? lanes.map(lane => laneHeader(lane, 'col')) : data.columns.map(reg => registerHeader(reg, 'col'));
    const lines = transposed
      ? data.columns.map(reg => ({
        label: registerHeader(reg, 'row'),
        cells: lanes.map(lane => cell(lane, reg)),
      }))
      : lanes.map(lane => ({
        label: laneHeader(lane, 'row'),
        cells: data.columns.map(reg => cell(lane, reg)),
      }));
    const table = makeTable(headers, lines, transposed ? 'VGPR' : 'Lane');
    table.classList.toggle('is-transposed', transposed);
    registerScroll.replaceChildren(table);
  }

  function setHighlights() {
    for (const button of highlighted) {
      button.removeAttribute('data-highlight');
    }
    highlighted = [];
    const active = selected.type === 'element'
      ? { entry: activeEntries()[0] }
      : selected.laneOnly ? { lane: selected.lane }
        : { lane: selected.lane, columns: selected.columns };
    const target = preview ?? active;
    const laneOnly = target.lane !== undefined && !target.columns;
    const locations = target.entry?.locations ?? (target.location ? [target.location] : []);
    const columns = target.columns ?? (target.register ? [target.register] : locations);
    const lanes = new Set(target.lane === undefined ? locations.map(loc => loc.lane) : [target.lane]);
    const offsets = new Set(columns.flatMap(col => Array.from({ length: col.count }, (_, index) => col.reg + index)));
    const exactKeys = new Set([
      ...locations.map(loc => amdLayout.name(loc, true)),
      ...(target.columns ?? []).map(col => amdLayout.name({ ...col, lane: target.lane }, true)),
    ]);
    const exactMatrix = target.entry?.matrix ?? matrix;

    function paint(button, cellLocations, exact = false) {
      let type;
      if (exact) type = 'exact';
      else if (cellLocations.some(loc => lanes.has(loc.lane))) type = 'lane';
      else if (cellLocations.some(loc => offsets.has(loc.reg) || (loc.count === 2 && offsets.has(loc.reg + 1)))) type = 'register';
      if (type) {
        button.dataset.highlight = type;
        highlighted.push(button);
      }
    }
    for (const { cells } of matrixViews.values()) {
      for (const { button, entry } of cells.values()) {
        const exact = target.entry ? entry === target.entry
          : entry.matrix === exactMatrix && entry.locations.some(loc => exactKeys.has(amdLayout.name(loc, true)));
        paint(button, entry.locations, exact);
      }
    }
    for (const [key, { button, location }] of registerCells) {
      const exact = !laneOnly && exactMatrix === matrix && exactKeys.has(key);
      paint(button, [location], exact);
    }
  }

  function setPreview(target) {
    if (preview === target) return;
    preview = target;
    let label = 'Move over a cell to highlight its lane and VGPR.';
    if (target?.entry) {
      const { entry } = target;
      label = entry.label + ' → ' + entry.locations.map(loc => layout.decorate(amdLayout.name(loc, true), entry.matrix, loc)).join(' · ');
    } else if (target?.location) {
      const key = amdLayout.name(target.location, true);
      const names = (data.byLocation.get(key) ?? []).map(entry => layout.decorate(entry.label, matrix, target.location));
      label = key + (names.length ? ' → ' + names.join(' · ') : ' · unused');
    } else if (target?.lane !== undefined) {
      label = 'T' + target.lane + ' · lane ' + target.lane;
    } else if (target?.register) {
      label = amdLayout.name(target.register) + ' · VGPR offset';
    }
    previewValue.textContent = label;
    setHighlights();
  }

  function textLink(label, onClick) {
    const button = el('button', '', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function renderSelection(reveal, savedLookup) {
    preview = null;
    previewValue.textContent = 'Move over a cell to highlight its lane and VGPR.';
    selectionValue.replaceChildren();
    const entries = activeEntries();
    const first = entries[0];
    let firstRegister;
    if (selected.type === 'element') {
      selectionValue.append(el('span', 'active-label', first.label + ' →'));
      for (const location of first.locations) {
        const key = amdLayout.name(location, true);
        const button = registerCells.get(key)?.button;
        firstRegister ??= button;
        selectionValue.append(textLink(layout.decorate(key, matrix, location), () => {
          pickRegisters(location.lane, [amdLayout.name(location)], 'both');
          const match = registerCells.get(key)?.button;
          match?.scrollIntoView({ block: 'center', inline: 'nearest' });
          match?.focus({ preventScroll: true });
        }));
      }
      laneInput.value = String(first.locations[0].lane);
      registerInput.value = amdLayout.name(first.locations[0]);
    } else {
      const { columns, lane } = selected;
      laneInput.value = String(lane);
      registerInput.value = amdLayout.name(columns[0]);
      const label = selected.laneOnly ? `Lane ${lane}` : columns.map(col => amdLayout.name({ ...col, lane }, true)).join(', ');
      selectionValue.append(el('span', 'active-label', label + ' →'));
      for (const col of columns) {
        const button = registerCells.get(amdLayout.name({ ...col, lane }, true))?.button;
        firstRegister ??= button;
      }
      for (const entry of new Set(entries)) {
        const location = entry.locations.find(loc => loc.lane === lane);
        selectionValue.append(textLink(layout.decorate(entry.label, matrix, location), () => {
          pickElement(entry.row, entry.col, entry.block, 'both');
          revealMatrixSelection();
        }));
      }
      if (!first) selectionValue.append(el('span', 'muted', 'No elements in this register slot.'));
    }
    const currentBlock = entries.find(entry => entry.block === block);
    rowInput.value = currentBlock ? String(currentBlock.row) : '';
    colInput.value = currentBlock ? String(currentBlock.col) : '';
    for (const input of lookupInputs) {
      const value = savedLookup?.[input.id];
      if (typeof value === 'string' && (input !== registerInput || [...registerInput.options].some(option => option.value === value))) {
        input.value = value;
      }
    }
    setHighlights();
    if (reveal === 'register' || reveal === 'both') revealCell(registerScroll, firstRegister);
    renderTrace();
    rememberInstructionSelection();
  }

  function revealCell(container, button) {
    if (!button) return;
    const bounds = container.getBoundingClientRect();
    const item = button.getBoundingClientRect();
    const header = container.querySelector('thead').getBoundingClientRect();
    const gutter = container.querySelector('tbody th').getBoundingClientRect().width;
    if (item.top < bounds.top + header.height || item.bottom > bounds.bottom) {
      container.scrollTop += item.top - bounds.top - container.clientHeight / 2;
    }
    if (item.left < bounds.left + gutter || item.right > bounds.right) {
      container.scrollLeft += item.left - bounds.left - gutter - 8;
    }
  }

  function revealMatrixSelection() {
    const view = matrixViews.get(panelKey(matrix));
    const entry = activeEntries().find(item => item.block === block);
    const target = entry ? view.cells.get(coordinateKey(entry.row, entry.col))?.button : view.panel;
    if (!target) return;
    const { top, bottom, left, right } = target.getBoundingClientRect();
    if (entry) {
      const gridBounds = view.grid.getBoundingClientRect();
      const gutter = view.grid.querySelector('tbody th').getBoundingClientRect().width;
      if (left < gridBounds.left + gutter) view.grid.scrollLeft += left - gridBounds.left - gutter;
      else if (right > gridBounds.right) view.grid.scrollLeft += right - gridBounds.right;
    }
    const visibleTop = Math.max(0, document.querySelector('.selection').getBoundingClientRect().bottom);
    if (top < visibleTop || bottom > window.innerHeight) target.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function appendSource(cell, value) {
    const { matrix: sourceMatrix, entry, location, locations } = value;
    const raw = entry?.label ?? `${sourceMatrix}[${value.row}][${value.col}]`;
    const label = layout.decorate(raw, sourceMatrix, location);
    const button = textLink(label, () => {
      useMatrix(sourceMatrix, entry ?? value);
      revealMatrixSelection();
    });
    button.className = 'source-button';
    const modified = layout.sign(sourceMatrix, location);
    const semantics = instruction.integer && instruction.neg && ['A', 'B'].includes(sourceMatrix)
      ? (modified.signed ? ' · signed' : ' · unsigned') : '';
    cell.append(button);
    for (const sourceLocation of locations) {
      cell.append(el('small', '', amdLayout.name(sourceLocation, true) + semantics));
    }
  }

  function renderTrace() {
    const entries = matrix === 'D' ? [...new Set(activeEntries())] : [];
    tracePanel.hidden = entries.length === 0;
    if (entries.length === 0) return;
    byId('trace-caption').textContent = entries.length === 1 ? entries[0].label : entries.length + ' outputs';
    if (!tracePanel.open) return;
    const groups = [];
    for (const entry of entries) {
      const { terms, accumulator, scales } = layout.trace(entry);
      const group = el('section', 'trace-group');
      const sum = instruction.scaled ? 'Σg (Ax[i][g] × Bx[g][j] × Σk∈g A[i][k] × B[k][j])' : 'Σ A × B';
      group.append(el('p', 'trace-note', instruction.sparse
        ? `${entry.label} += ${sum} · The compression index selects 2 of every 4 candidate A values.`
        : `${entry.label} = ${sum} ${layout.sign('C', accumulator.location).negative ? '−' : '+'} C`));
      if (scales.length) {
        const scaleRows = scales.map(({ start, end, a, b }) => {
          const cells = [a, b].map(source => {
            const cell = el('td');
            appendSource(cell, source);
            return cell;
          });
          return { label: heading(`${start}–${end}`, null, null, 'row'), cells };
        });
        const scaleTable = makeTable([heading('Ax · ScaleSrc0'), heading('Bx · ScaleSrc1')], scaleRows, 'K group');
        scaleTable.className = 'trace-table scale-trace';
        group.append(scaleTable);
      }
      if (instruction.arch === 'rdna3') {
        group.append(el('p', 'trace-note', 'A and B values are replicated across lane groups.'));
      }
      const table = el('table', 'trace-table');
      const header = el('thead');
      const title = el('tr');
      const columns = ['k', 'A · Src0', 'B · Src1'];
      if (instruction.sparse) columns.push('K · Src2');
      title.append(...columns.map(label => el('th', '', label)));
      header.append(title);
      const body = el('tbody');
      for (const term of terms) {
        const line = el('tr');
        line.append(el('th', '', term.k));
        for (const source of [term.a, term.b, term.index].filter(Boolean)) {
          const cell = el('td');
          appendSource(cell, source);
          line.append(cell);
        }
        body.append(line);
      }
      const footer = el('tfoot');
      const total = el('tr');
      const value = el('td');
      value.colSpan = columns.length - 1;
      appendSource(value, accumulator);
      total.append(el('th', '', 'Accumulator'), value);
      footer.append(total);
      table.append(header, body, footer);
      group.append(table);
      groups.push(group);
    }
    traceContent.replaceChildren(...groups);
  }

  function download(kind, format, operand = matrix) {
    const data = layout.table(operand);
    const transposed = kind === 'matrix' ? transposedMatrices.has(panelKey(operand)) : registerTranspose.checked;
    const transpose = rows => transposed ? amdExports.transpose(rows) : rows;
    const activeAxes = transposed ? [...axes[operand]].reverse() : axes[operand];
    let tables;
    if (kind === 'matrix') {
      const blocks = data.coordinates.map(tile => {
        const header = [`${operand}[${activeAxes[0].toUpperCase()}][${activeAxes[1].toUpperCase()}]`, ...tile[0].map((_, col) => col)];
        const rows = tile.map((row, r) => [r, ...row.map(entry =>
          entry.locations.map(location => layout.decorate(amdLayout.name(location, true), operand, location)))]);
        return transpose([header, ...rows]);
      });
      if (format.id === 'csv' && instruction.blocks > 1) {
        const allRows = blocks.flatMap((table, index) => table.slice(1).map(row => [index, ...row]));
        tables = [amdExports.render([['block', ...blocks[0][0]], ...allRows], format.id)];
      } else {
        tables = blocks.map((table, idx) => {
          const rendered = amdExports.render(table, format.id);
          if (instruction.blocks === 1) return rendered;
          const label = `Block ${idx}`;
          return (format.id === 'markdown' ? '### ' + label : label) + '\n' + rendered;
        });
      }
    } else {
      const rows = Array.from({ length: wave }, (_, lane) => [
        lane,
        ...data.columns.map(col => (data.byLocation.get(amdLayout.name({ ...col, lane }, true)) ?? [])
          .map(entry => layout.decorate(entry.label, operand, col))),
      ]);
      tables = [amdExports.render(transpose([['lane', ...data.columns.map(col => amdLayout.name(col))], ...rows]), format.id)];
    }
    const name = [instruction.arch, mnemonic, 'wave' + wave, operand, kind, transposed ? 'transposed' : 'layout'].join('-');
    amdExports.download(name + '.' + format.extension, tables.join('\n\n') + '\n', format.mime);
  }

  function setupExport(menu, kind, operand) {
    for (const format of amdExports.formats) {
      const button = el('button', '', format.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        download(kind, format, operand?.());
        menu.closest('details').open = false;
      });
      menu.append(button);
    }
  }

  function previewTarget(node) {
    if (!(node instanceof Element)) return null;
    const button = node.closest('button');
    if (!button) return null;
    for (const view of matrixViews.values()) {
      const target = view.targets.get(button);
      if (target) return target;
    }
    return registerTargets.get(button) ?? null;
  }

  panels.addEventListener('pointerover', event => {
    if (event.pointerType !== 'touch') setPreview(previewTarget(event.target));
  });
  panels.addEventListener('pointerleave', () => setPreview(null));
  panels.addEventListener('focusin', event => setPreview(previewTarget(event.target)));
  panels.addEventListener('focusout', event => setPreview(previewTarget(event.relatedTarget)));

  architecture.addEventListener('change', () => {
    filter.value = '';
    fillInstructions(mnemonic);
    configureInstruction();
  });
  filter.addEventListener('input', () => {
    fillInstructions(mnemonic);
    if (instructionSelect.value !== mnemonic) configureInstruction();
  });
  instructionSelect.addEventListener('change', () => configureInstruction());
  for (const input of lookupInputs) input.addEventListener('input', rememberInstructionSelection);
  waveSelect.addEventListener('change', () => {
    wave = Number(waveSelect.value);
    configureModifiers();
    rebuild();
  });
  blockSelect.addEventListener('change', () => {
    block = Number(blockSelect.value);
    if (selected.type === 'element') selected = { ...selected, block };
    renderMatrices();
    renderSelection('matrix');
  });
  registerTranspose.addEventListener('change', () => {
    renderRegisters();
    renderSelection('register');
  });
  showLocations.addEventListener('change', () => {
    for (const [key, view] of matrixViews) renderMatrix(key, view);
    setPreview(null);
    setHighlights();
  });
  byId('coordinate-form').addEventListener('submit', event => {
    event.preventDefault();
    pickElement(rowInput.valueAsNumber, colInput.valueAsNumber, block, 'both');
    revealMatrixSelection();
  });
  byId('register-form').addEventListener('submit', event => {
    event.preventDefault();
    const value = registerInput.value;
    const physical = Number(value.split(':')[1]);
    const keys = value.startsWith('physical:')
      ? data.columns.filter(loc => loc.reg <= physical && physical < loc.reg + loc.count).map(col => amdLayout.name(col))
      : [value];
    pickRegisters(laneInput.valueAsNumber, keys, 'both');
    revealMatrixSelection();
  });
  tracePanel.addEventListener('toggle', renderTrace);
  byId('show-details').addEventListener('click', () => byId('detail-dialog').showModal());
  setupExport(registerPanel.querySelector('.export-options'), 'register');
  document.addEventListener('click', event => {
    for (const menu of document.querySelectorAll('.export-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });

  const initialChoice = initialInstructionSelection();
  fillArchitectures();
  if (Object.hasOwn(instructions, initialChoice.arch)) architecture.value = initialChoice.arch;
  fillInstructions(initialChoice.mnemonic ?? preferred);
  configureInstruction(initialChoice);
  window.addEventListener('hashchange', rememberInstructionSelection);
  new ResizeObserver(() => {
    for (const view of matrixViews.values()) updateMatrixScrollbar(view);
  }).observe(panels);
})();
