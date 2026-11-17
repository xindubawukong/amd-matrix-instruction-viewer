# AMD Matrix Instruction Viewer

Open `index.html` in a browser. The viewer runs offline with no runtime dependencies, build step, or server.

Choose an architecture, instruction, and wavefront width. Matrices A, B, and C/D appear in order, with K below D for sparse instructions. Drag the bar above a wide matrix to scroll horizontally. Each panel has its own transpose control. C and D share one layout and can be switched within the same panel. Hover a cell to highlight its lane and VGPR offset across the matrices. Click to select the cell and make its operand active for the coordinate and register forms. Click a register cell or lane header to look up the matching elements. For instructions with multiple independent multiplication blocks, use the Block selector to switch the matrix views. The reverse view covers all blocks.

Modifiers update both views and the output calculation. For D, open Output calculation to trace the products and accumulator. RDNA 3 traces show all lane copies of replicated A and B values. Sparse traces include the compression index locations and show candidate A values. The actual nonzero entries depend on the index data supplied to the hardware.

Instruction details include the original opcode, performance figures, register requirements, and mapping equations. Both layout tables support transposition and export as CSV, Markdown, AsciiDoc, and plain text. Matrix exports include all blocks.

The CDNA 1–3 and RDNA 3–4 data and layout rules come from the MIT-licensed [AMD Matrix Instruction Calculator v1.3.2](https://github.com/ROCm/amd_matrix_instruction_calculator/tree/2ef9189). See [LICENSE](LICENSE).

The viewer also covers the 68 CDNA 4 (gfx950) MFMA and SMFMAC mnemonics in the [ROCm assembler reference](https://rocmdocs.amd.com/projects/llvm-project/en/latest/reference/AMDGPU/AMDGPUAsmGFX950.html). The layouts follow Chapter 7 of the [CDNA 4 ISA guide](https://www.amd.com/content/dam/amd/en/documents/instinct-tech-docs/instruction-set-architectures/amd-instinct-cdna4-instruction-set-architecture.pdf). Use the format selectors for mixed FP8/BF8/FP6/BF6/FP4 instructions. FP6/BF6 elements can span two registers. Scaled instructions also display Ax and Bx, with one E8M0 value per group of 32 K positions and a selectable byte in each scale source.

Open [gfx950 ISA reference](gfx950.html) to search all 1,240 instructions and 101 alias entries from AMD's [machine-readable CDNA 4 ISA](https://gpuopen.com/machine-readable-isa/). The catalog includes encoding variants, opcodes, and operand access, formats, and widths. The matrix-kernel filter includes MFMA, LDS transpose loads, low-precision conversion, AccVGPR moves, direct-to-LDS loads, and packed dot products. MFMA entries link to their interactive layouts.
