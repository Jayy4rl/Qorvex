/** Read the exported function names from a wasm binary (the contract's callable methods). */
export function exportedFunctions(code: Uint8Array): string[] {
  if (code.length < 8 || code[0] !== 0 || code[1] !== 0x61 || code[2] !== 0x73 || code[3] !== 0x6d) throw new Error("not a wasm module");
  let i = 8;
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = code[i++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  const out: string[] = [];
  while (i < code.length) {
    const id = code[i++];
    const size = leb();
    const end = i + size;
    if (id === 7) {
      const count = leb();
      for (let k = 0; k < count; k++) {
        const len = leb();
        const name = Buffer.from(code.subarray(i, i + len)).toString("utf8");
        i += len;
        const kind = code[i++];
        leb(); // index
        if (kind === 0) out.push(name);
      }
      return out;
    }
    i = end;
  }
  return out;
}
