// Layout rules adapted from AMD Matrix Instruction Calculator v1.3.2. See LICENSE.
const amdLayout = (() => {
  const floor = Math.floor;
  const isInput = matrix => ['A', 'B', 'K'].includes(matrix);
  const sizeOf = type => amdInstructionData.types[type].size;
  const scaleBlockSize = 32;

  function matrices(instruction) {
    if (instruction.scaled) return ['A', 'B', 'C', 'D', 'Ax', 'Bx'];
    return instruction.sparse ? ['A', 'B', 'K', 'D'] : ['A', 'B', 'C', 'D'];
  }

  function dimensions(instruction, matrix) {
    if (matrix === 'Ax') return [instruction.m, instruction.k / scaleBlockSize];
    if (matrix === 'Bx') return [instruction.k / scaleBlockSize, instruction.n];
    if (matrix === 'A' || matrix === 'K') return [instruction.m, instruction.k];
    if (matrix === 'B') return [instruction.k, instruction.n];
    return [instruction.m, instruction.n];
  }

  function packing(size, slot, sparse = false) {
    if (size === 64) return { reg: slot * 2, count: 2 };
    if (size === 32) return { reg: slot, count: 1 };
    if (size === 16 && sparse) return { reg: floor(slot / 2), count: 1 };
    const width = sparse ? size * 2 : size;
    const low = (floor(slot * size / width) * width) % 32;
    return { reg: floor(slot * size / 32), count: 1, low, high: low + width - 1 };
  }

  function bits(reg, low, width) {
    return { reg, count: 1, low, high: low + width - 1 };
  }

  function name(location, includeLane = false) {
    const { reg, count, low, high, lane } = location;
    const register = count === 2 ? `v[${reg + 1}:${reg}]` : `v${reg}`;
    const laneText = includeLane ? `{${lane}}` : '';
    return register + laneText + (low === undefined ? '' : `.[${high}:${low}]`);
  }

  function elementName(matrix, row, col, block, instruction) {
    const suffix = instruction.blocks > 1 ? `.B${block}` : '';
    return `${matrix}[${row}][${col}]${suffix}`;
  }

  function compressionSets(instruction, wave) {
    if (!instruction.sparse) return 0;
    const size = sizeOf(instruction.in_type);
    if (instruction.arch === 'cdna3') return size === 16 ? 4 : 2;
    if (instruction.arch === 'cdna4') return 32 / (instruction.k * instruction.m / 64);
    if (wave === 32) return size === 4 && instruction.k === 64 ? 1 : 2;
    return size === 4 ? 2 : 4;
  }

  function modifierOptions(instruction, wave, cbsz = 0) {
    const options = [];
    if (instruction.mixed) {
      options.push(['aFormat', 'A format · CBSZ', 4], ['bFormat', 'B format · BLGP', 4]);
    }
    if (instruction.scaled) {
      options.push(['scaleAByte', 'Ax byte · OPSEL', 3], ['scaleBByte', 'Bx byte · OPSEL', 3]);
    }
    if (instruction.cbsz_abid) {
      const cbszMax = instruction.sparse ? 3 : Math.min(4, Math.log2(instruction.blocks));
      const validCbsz = Number.isInteger(cbsz) && cbsz >= 0 && cbsz <= cbszMax ? cbsz : 0;
      const abidMax = instruction.sparse ? compressionSets(instruction, wave) - 1 : 2 ** validCbsz - 1;
      options.push(['cbsz', 'CBSZ', cbszMax], ['abid', 'ABID', abidMax]);
    }
    if (instruction.blgp) options.push(['blgp', 'BLGP', 7]);
    if (instruction.cd_opsel) options.push(['opsel', 'OPSEL', [0, 4]]);
    if (instruction.arch === 'rdna4' && instruction.sparse) {
      options.push(['opsel', 'OPSEL', compressionSets(instruction, wave) - 1]);
    }
    if (instruction.neg) {
      options.push(['neg', 'NEG', instruction.integer ? 3 : 7]);
      if (!instruction.integer) options.push(['neg_hi', 'NEG_HI', 7]);
    }
    return options;
  }

  const bLanePatterns = [
    lane => lane,
    lane => lane % 32,
    lane => lane % 32 + 32,
    lane => (lane + 16) % 64,
    ...[0, 16, 32, 48].map(start => lane => start + lane % 16),
  ];

  function cdna4StripedInput(instruction, size, outer, axis, inner) {
    const { k } = instruction;
    // F8 in F8F6F4 and dense B in wide SMFMAC are striped across two K halves.
    const half = k / 2;
    const perLane = half * outer / 64;
    const withinHalf = inner % half;
    const lane = axis + outer * floor(withinHalf / perLane);
    const slot = withinHalf % perLane + floor(inner / half) * perLane;
    return [{ ...packing(size, slot), lane }];
  }

  function cdna4MixedInput(instruction, size, outer, axis, inner) {
    if (size === 8) return cdna4StripedInput(instruction, size, outer, axis, inner);
    const lane = axis + outer * floor(inner / scaleBlockSize);
    const startBit = (inner % scaleBlockSize) * size;
    const register = floor(startBit / 32);
    const offset = startBit % 32;
    const firstWidth = Math.min(size, 32 - offset);
    const locations = [{ ...bits(register, offset, firstWidth), lane }];
    if (firstWidth < size) {
      locations.push({ ...bits(register + 1, 0, size - firstWidth), lane });
    }
    return locations;
  }

  function gfx9(instruction, matrix, row, col, block, mods) {
    const { m, n, k, blocks, sparse } = instruction;
    if (matrix === 'Ax') return [{ ...bits(0, mods.scaleAByte * 8, 8), lane: row + m * col }];
    if (matrix === 'Bx') return [{ ...bits(0, mods.scaleBByte * 8, 8), lane: col + n * row }];
    if (!isInput(matrix)) {
      const size = sizeOf(instruction.out_type);
      const rowGroup = size === 64 ? 1 : 4;
      const laneGroups = 64 / n;
      const blocksPerRegister = Math.ceil(64 / (m * n / rowGroup));
      if (instruction.arch === 'cdna4') {
        const rowsPerRegister = laneGroups / blocksPerRegister;
        const groups = m / (rowGroup * rowsPerRegister);
        const slot = row % rowGroup + rowGroup
          * (floor(row / (rowGroup * rowsPerRegister)) + groups * floor(block / blocksPerRegister));
        const lane = col + n * (floor(row / rowGroup) % rowsPerRegister + rowsPerRegister * (block % blocksPerRegister));
        return [{ ...packing(size, slot), lane }];
      }
      const slot = block * floor(m * n / 64)
        + floor(row / (rowGroup * laneGroups)) * rowGroup + row % rowGroup;
      const lane = (block % blocksPerRegister + floor(row / rowGroup) % laneGroups * blocksPerRegister) * n + col;
      return [{ ...packing(size, slot), lane }];
    }

    const isB = matrix === 'B';
    const size = sizeOf(instruction.mixed ? amdCdna4.dataTypes(instruction, mods)[Number(isB)]
      : isB ? instruction.in_type_src1 : instruction.in_type);
    const outer = isB ? n : m;
    const axis = isB ? col : row;
    if (instruction.mixed) return cdna4MixedInput(instruction, size, outer, axis, isB ? row : col);
    if (instruction.wide_sparse && isB) return cdna4StripedInput(instruction, size, outer, axis, row);
    const isSparseA = sparse && !isB;
    const inner = isB ? row : isSparseA ? floor(col / 2) : col;
    const stride = floor((isSparseA ? k / 2 : k) / floor(64 / (outer * blocks)));
    const slot = inner % stride;
    if (matrix === 'A' && !sparse && instruction.arch !== 'cdna4') {
      const broadcastSize = 2 ** mods.cbsz;
      block = floor(block / broadcastSize) * broadcastSize + mods.abid;
    }
    let lane = block * outer + floor(inner / stride) * outer * blocks + axis;
    if (matrix === 'A' && !sparse && instruction.arch === 'cdna4' && mods.cbsz) {
      const broadcastSpan = 64 / 2 ** mods.cbsz;
      lane = lane % broadcastSpan + broadcastSpan * mods.abid;
    }
    if (isB && instruction.in_type !== 'fp64') lane = bLanePatterns[mods.blgp](lane);

    if (matrix === 'K') {
      if (instruction.arch === 'cdna4') {
        const indexSet = mods.cbsz === 0 && instruction.cbsz_abid ? mods.abid : 0;
        return [{ ...bits(0, floor(slot / 2) * 4 + indexSet * stride * 2, 4), lane }];
      }
      const shiftedSlot = slot + (mods.cbsz === 0 ? floor(64 * mods.abid / size) : 0);
      return [{ ...bits(0, floor(shiftedSlot / 2) * 4, 4), lane }];
    }
    return [{ ...packing(size, slot, isSparseA), lane }];
  }

  function gfx11(instruction, wave, matrix, row, col, opsel) {
    if (isInput(matrix)) {
      const inner = matrix === 'B' ? row : col;
      const outer = matrix === 'B' ? col : row;
      const size = sizeOf(matrix === 'B' ? instruction.in_type_src1 : instruction.in_type);
      const storage = packing(size, inner);
      return Array.from({ length: wave / 16 }, (_, group) => ({ ...storage, lane: outer + group * 16 }));
    }
    const size = sizeOf(instruction.out_type);
    const slot = (size === 16 ? 2 : 1) * floor(row / (wave / 16)) + (opsel >> 2);
    return [{ ...packing(size, slot), lane: (instruction.n * row + col) % wave }];
  }

  function gfx12InputStorage(instruction, wave, matrix, inner, opsel) {
    const { sparse, k } = instruction;
    const size = sizeOf(matrix === 'B' ? instruction.in_type_src1 : instruction.in_type);
    const group = width => floor(inner / width);
    const wave32 = wave === 32;

    if (matrix === 'K') {
      let slot;
      if (wave32 && size === 16) slot = 2 * group(16) + group(4) % 2;
      else if (wave32) slot = group(4) % (size === 8 || k === 32 ? 4 : 8);
      else slot = group(4) % (size === 4 ? 4 : 2);
      return bits(0, 4 * slot + opsel * (32 / compressionSets(instruction, wave)), 4);
    }

    if (sparse && matrix === 'A') {
      if (size === 16) return { reg: (wave32 ? 2 * group(16) : 0) + group(4) % 2, count: 1 };
      let reg = 0;
      if (wave32 && size === 8) reg = group(8) % 2;
      if (wave32 && size === 4 && k === 64) reg = group(16) % 2;
      return bits(reg, 2 * size * (group(4) % (16 / size)), 2 * size);
    }

    let reg = 0;
    if (sparse) {
      if (size === 16) reg = (wave32 ? 4 * group(16) : 0) + group(2) % 4;
      else if (size === 8) reg = group(4) % (wave32 ? 4 : 2);
      else reg = group(8) % (k === 32 ? (wave32 ? 2 : 1) : (wave32 ? 4 : 2));
    } else if (size === 16) {
      reg = (wave32 ? 2 * group(8) : 0) + group(2) % 2;
    } else if (wave32) {
      if (size === 8) reg = group(4) % 2;
      else if (k === 32) reg = group(8) % 2;
    }
    return bits(reg, size * (inner % (32 / size)), size);
  }

  function gfx12InputLane(instruction, wave, matrix, inner, outer) {
    const size = sizeOf(matrix === 'B' ? instruction.in_type_src1 : instruction.in_type);
    const group = width => floor(inner / width);
    const { sparse, k } = instruction;
    if (sparse) {
      if (wave === 32) {
        if (size === 16) return 16 * (group(8) % 2) + outer;
        return 16 * group(k === 64 ? 32 : 16) + outer;
      }
      if (size === 16) return 16 * group(8) + outer;
      if (size === 4 && k === 32 && matrix !== 'B') return 16 * group(16) + outer;
      if (k === 64) return 32 * (group(16) % 2) + 16 * group(32) + outer;
      return 32 * (group(8) % 2) + 16 * group(16) + outer;
    }
    if (wave === 32) {
      if (size === 16) return 16 * (group(4) % 2) + outer;
      return 16 * group(size === 4 && k === 32 ? 16 : 8) + outer;
    }
    if (size === 16) return 32 * (group(8) % 2) + 16 * (group(4) % 2) + outer;
    if (size === 8) return 32 * (group(4) % 2) + 16 * (group(8) % 2) + outer;
    if (k === 16) return 16 * group(8) + outer;
    return 32 * (group(8) % 2) + 16 * (group(16) % 2) + outer;
  }

  function gfx12(instruction, wave, matrix, row, col, opsel) {
    if (isInput(matrix)) {
      const inner = matrix === 'B' ? row : col;
      const outer = matrix === 'B' ? col : row;
      const storage = gfx12InputStorage(instruction, wave, matrix, inner, opsel);
      return [{ ...storage, lane: gfx12InputLane(instruction, wave, matrix, inner, outer) }];
    }
    const size = sizeOf(instruction.out_type);
    const storage = packing(size, row % (wave === 32 ? 8 : 4));
    const lane = (wave === 64 ? 32 * (floor(row / 4) % 2) : 0) + 16 * floor(row / 8) + col;
    return [{ ...storage, lane }];
  }

  const defaults = {
    cbsz: 0, abid: 0, blgp: 0, opsel: 0, neg: 0, neg_hi: 0,
    aFormat: 0, bFormat: 0, scaleAByte: 0, scaleBByte: 0,
  };

  function create(instruction, wave, modifiers = {}) {
    const mods = { ...defaults, ...modifiers };
    const mapped = new Map();
    const baseMapped = new Map();

    function locate(matrix, row, col, block = 0, active = mods) {
      if (instruction.arch.startsWith('cdna')) return gfx9(instruction, matrix, row, col, block, active);
      if (instruction.arch === 'rdna3') return gfx11(instruction, wave, matrix, row, col, active.opsel);
      return gfx12(instruction, wave, matrix, row, col, active.opsel);
    }

    function table(matrix, original = false) {
      const cache = original ? baseMapped : mapped;
      if (cache.has(matrix)) return cache.get(matrix);
      const [rows, cols] = dimensions(instruction, matrix);
      const coordinates = [];
      const byLocation = new Map();
      const columns = new Map();
      const active = original ? { ...mods, cbsz: 0, abid: 0, blgp: 0 } : mods;
      for (let block = 0; block < instruction.blocks; block++) {
        const tile = [];
        for (let row = 0; row < rows; row++) {
          const line = [];
          for (let col = 0; col < cols; col++) {
            const locations = locate(matrix, row, col, block, active);
            const entry = { matrix, row, col, block, locations, label: elementName(matrix, row, col, block, instruction) };
            line.push(entry);
            for (const location of locations) {
              const registerName = name(location);
              const key = name(location, true);
              if (!byLocation.has(key)) byLocation.set(key, []);
              byLocation.get(key).push(entry);
              columns.set(registerName, location);
            }
          }
          tile.push(line);
        }
        coordinates.push(tile);
      }
      const sorted = [...columns.values()].sort((a, b) => a.reg - b.reg || (a.low ?? 0) - (b.low ?? 0));
      const layouts = { coordinates, byLocation, columns: sorted };
      cache.set(matrix, layouts);
      return layouts;
    }

    function sign(matrix, location) {
      const index = ['A', 'B', 'C'].indexOf(matrix);
      if (index === -1) return { negative: false, absolute: false, signed: false };
      const mask = 1 << index;
      if (instruction.blgp && instruction.in_type === 'fp64') {
        return { negative: Boolean(mods.blgp & mask), absolute: false, signed: false };
      }
      if (instruction.integer) {
        return { negative: false, absolute: false, signed: Boolean(mods.neg & mask) };
      }
      if (matrix === 'C') return { negative: Boolean(mods.neg & 4), absolute: Boolean(mods.neg_hi & 4), signed: false };
      const field = location.low === 0 && location.high === 15 ? mods.neg
        : location.low === 16 && location.high === 31 ? mods.neg_hi : 0;
      return { negative: Boolean(field & mask), absolute: false, signed: false };
    }

    function decorate(label, matrix, location) {
      const { negative, absolute } = sign(matrix, location);
      return (negative ? '-' : '') + (absolute ? `|${label}|` : label);
    }

    function source(matrix, row, col, block) {
      const locations = locate(matrix, row, col, block);
      const [location] = locations;
      const originals = table(matrix, true).byLocation.get(name(location, true)) ?? [];
      const entry = originals.find(item => matrix !== 'A' || item.col === col) ?? originals[0];
      return { matrix, row, col, block, location, locations, entry };
    }

    function trace(output) {
      const { row, col, block } = output;
      const terms = Array.from({ length: instruction.k }, (_, k) => {
        const a = source('A', row, k, block);
        const b = source('B', k, col, block);
        const index = instruction.sparse ? source('K', row, k, block) : null;
        return { k, a, b, index };
      });
      const accumulator = instruction.sparse
        ? source('D', row, col, block)
        : source('C', row, col, block);
      const scales = instruction.scaled ? Array.from({ length: instruction.k / scaleBlockSize }, (_, group) => ({
        start: group * scaleBlockSize,
        end: (group + 1) * scaleBlockSize - 1,
        a: source('Ax', row, group, block),
        b: source('Bx', group, col, block),
      })) : [];
      return { terms, accumulator, scales };
    }

    return { locate, table, trace, decorate, sign };
  }

  return { create, name, matrices, dimensions, modifierOptions, sizeOf };
})();
