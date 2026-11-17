// AMD CDNA4 ISA Reference Guide §§7.1–7.5 and LLVM's gfx950 VOP3P/VOP3PX2 encodings.
const amdCdna4 = (() => {
  const isa = 'https://www.amd.com/content/dam/amd/en/documents/instinct-tech-docs/instruction-set-architectures/amd-instinct-cdna4-instruction-set-architecture.pdf';
  const formats = ['fp8', 'bf8', 'fp6', 'bf6', 'fp4'];
  const formatLabels = ['FP8 · E4M3', 'BF8 · E5M2', 'FP6 · E2M3', 'BF6 · E3M2', 'FP4 · E2M1'];

  Object.assign(amdInstructionData.types, {
    fp6: { size: 6, description: 'FP6 (OCP E2M3)' },
    bf6: { size: 6, description: 'BF6 (OCP E3M2)' },
    fp4: { size: 4, description: 'FP4 (OCP E2M1)' },
    e8m0: { size: 8, description: 'E8M0 (exponent-only scale, bias 127)' },
  });
  for (const alias of ['cdna4', 'gfx950', 'mi350', 'mi350x', 'mi355x']) {
    amdInstructionData.aliases[alias] = 'cdna4';
  }

  const wideOpcodes = [
    ['v_mfma_f32_16x16x32_f16', 0x54],
    ['v_mfma_f32_32x32x16_f16', 0x55],
    ['v_mfma_f32_16x16x32_bf16', 0x35],
    ['v_mfma_f32_32x32x16_bf16', 0x37],
    ['v_mfma_i32_16x16x64_i8', 0x36],
    ['v_mfma_i32_32x32x32_i8', 0x38],
    ['v_mfma_f32_16x16x128_f8f6f4', 0x2d],
    ['v_mfma_f32_32x32x64_f8f6f4', 0x2e],
    ['v_mfma_scale_f32_16x16x128_f8f6f4', 0x2d],
    ['v_mfma_scale_f32_32x32x64_f8f6f4', 0x2e],
    ['v_smfmac_f32_16x16x64_f16', 0x5a],
    ['v_smfmac_f32_32x32x32_f16', 0x5b],
    ['v_smfmac_f32_16x16x64_bf16', 0x39],
    ['v_smfmac_f32_32x32x32_bf16', 0x46],
    ['v_smfmac_i32_16x16x128_i8', 0x3a],
    ['v_smfmac_i32_32x32x64_i8', 0x47],
    ['v_smfmac_f32_16x16x128_bf8_bf8', 0x3b],
    ['v_smfmac_f32_16x16x128_bf8_fp8', 0x3c],
    ['v_smfmac_f32_16x16x128_fp8_bf8', 0x3d],
    ['v_smfmac_f32_16x16x128_fp8_fp8', 0x43],
    ['v_smfmac_f32_32x32x64_bf8_bf8', 0x4b],
    ['v_smfmac_f32_32x32x64_bf8_fp8', 0x4e],
    ['v_smfmac_f32_32x32x64_fp8_bf8', 0x4f],
    ['v_smfmac_f32_32x32x64_fp8_fp8', 0x53],
  ];

  const instructions = {};
  for (const [mnemonic, opcode] of wideOpcodes) {
    const [, output, m, n, k, first, second] = mnemonic.match(
      /^v_(?:mfma_scale|mfma|smfmac)_([fi]32)_(\d+)x(\d+)x(\d+)_([^_]+)(?:_(.+))?$/,
    );
    const types = { f16: 'fp16', i8: 'int8', f8f6f4: 'fp8' };
    const sparse = mnemonic.startsWith('v_smfmac');
    const mixed = first === 'f8f6f4';
    const integer = output === 'i32';
    const inputType = types[first] ?? first;
    instructions[mnemonic] = {
      arch: 'cdna4',
      opcode,
      m: Number(m),
      n: Number(n),
      k: Number(k),
      blocks: 1,
      in_type: inputType,
      in_type_src1: second ?? inputType,
      out_type: integer ? 'int32' : 'fp32',
      cycles: Number(m),
      sparse,
      integer,
      mixed,
      scaled: mnemonic.startsWith('v_mfma_scale'),
      wide_sparse: sparse,
      cbsz_abid: sparse && amdInstructionData.types[inputType].size === 16,
    };
  }

  // Retained gfx940-family opcodes, with gfx950-specific encodings and formats.
  const opcodeOverrides = { v_mfma_i32_16x16x32_i8: 0x57, v_mfma_i32_32x32x16_i8: 0x56 };
  for (const [mnemonic, info] of Object.entries(amdInstructionData.instructions.cdna3)) {
    if (info.in_type === 'xf32') continue;
    instructions[mnemonic] = {
      arch: 'cdna4',
      opcode: opcodeOverrides[mnemonic] ?? info.opcode,
      m: info.m,
      n: info.n,
      k: info.k,
      blocks: info.blocks,
      in_type: info.in_type.replace(/^amd_/, ''),
      in_type_src1: info.in_type_src1.replace(/^amd_/, ''),
      out_type: info.out_type,
      cycles: info.in_type === 'fp64' ? info.cycles * 2 : info.cycles,
      sparse: info.sparse,
      integer: info.integer,
      blgp: info.blgp,
      cbsz_abid: info.cbsz_abid,
    };
  }
  amdInstructionData.instructions.cdna4 = instructions;

  function dataTypes(instruction, modifiers) {
    if (!instruction.mixed) return [instruction.in_type, instruction.in_type_src1];
    return [formats[modifiers.aFormat ?? 0], formats[modifiers.bFormat ?? 0]];
  }

  function cycles(instruction, modifiers) {
    const needsDouble = instruction.mixed
      && dataTypes(instruction, modifiers).some(type => type === 'fp8' || type === 'bf8');
    return instruction.cycles * (needsDouble ? 2 : 1);
  }

  function details(mnemonic, instruction, modifiers) {
    const { m, n, k, blocks, sparse, scaled, out_type: output } = instruction;
    const [aType, bType] = dataTypes(instruction, modifiers);
    const bitWidth = type => amdInstructionData.types[type].size;
    const aWords = Math.ceil(m * k * blocks * bitWidth(aType) / (64 * 32 * (sparse ? 2 : 1)));
    const bWords = Math.ceil(n * k * blocks * bitWidth(bType) / (64 * 32));
    const outWords = Math.ceil(m * n * blocks * bitWidth(output) / (64 * 32));
    const opCount = 2 * m * n * k * blocks;
    const kind = instruction.integer ? 'integer operations' : 'FLOPs';
    return [
      'Architecture: CDNA 4 (gfx950, wave64)',
      'Instruction: ' + mnemonic.toUpperCase(),
      'Encoding: ' + (scaled ? 'VOP3PX2 (128-bit)' : 'VOP3P-MAI (64-bit)'),
      'VOP3P opcode: 0x' + instruction.opcode.toString(16),
      `Tile: ${m} × ${n} × ${k}, ${blocks} independent block${blocks === 1 ? '' : 's'}`,
      `Execution cycles: ${cycles(instruction, modifiers)}`,
      `Work per wave: ${opCount.toLocaleString('en-US')} ${kind}${sparse ? ' (dense equivalent)' : ''}`,
      '',
      'Operand storage per lane',
      `  A / Src0: ${aWords} VGPRs · ${amdInstructionData.types[aType].description}`,
      `  B / Src1: ${bWords} VGPRs · ${amdInstructionData.types[bType].description}`,
      sparse ? '  K / Src2: one VGPR · 4:2 compression indices'
        : `  C / Src2: ${outWords} VGPRs · ${amdInstructionData.types[output].description}`,
      `  D / Vdst: ${outWords} VGPRs · ${amdInstructionData.types[output].description}`,
      sparse ? '  The accumulator is read from Vdst.' : '',
      scaled ? '  Ax and Bx: one byte per lane in each scale source (or an inline constant).' : '',
      scaled ? '  One E8M0 factor per 32 consecutive K values.' : '',
      '',
      'Layouts: AMD CDNA 4 ISA Reference Guide, Chapter 7.',
    ].filter((line, i, lines) => line || (lines[i - 1] && lines[i + 1])).join('\n');
  }

  return { isa, formatLabels, dataTypes, cycles, details };
})();
