/**
 * Warm-isolate WASM wrapper for `sayso_wasm.wasm`.
 *
 * In Cloudflare Workers (`workerd`), importing `.wasm` yields a pre-compiled
 * `WebAssembly.Module` that stays warm across requests (`0 ms` cold load).
 * In Node.js tests, `SaySoCore.fromBytes` instantiates from disk bytes.
 */

export interface SaySoWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  sayso_alloc: (len: number) => number;
  sayso_dealloc: (ptr: number, cap: number) => void;
  sayso_call: (ptr: number, len: number) => bigint;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SaySoCore {
  private readonly exports: SaySoWasmExports;

  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as SaySoWasmExports;
  }

  static fromModuleSync(mod: WebAssembly.Module): SaySoCore {
    return new SaySoCore(new WebAssembly.Instance(mod, {}));
  }

  static async fromBytes(bytes: BufferSource): Promise<SaySoCore> {
    const instantiated = (await WebAssembly.instantiate(bytes, {})) as
      | { instance: WebAssembly.Instance }
      | WebAssembly.Instance;
    const instance = 'instance' in instantiated ? instantiated.instance : instantiated;
    return new SaySoCore(instance);
  }

  call<T = Record<string, unknown>>(payload: Record<string, unknown>): T {
    const inputBytes = encoder.encode(JSON.stringify(payload));
    const inPtr = this.exports.sayso_alloc(inputBytes.length);
    let outPtr = 0;
    let outLen = 0;
    try {
      new Uint8Array(this.exports.memory.buffer, inPtr, inputBytes.length).set(inputBytes);
      const packed = this.exports.sayso_call(inPtr, inputBytes.length);
      outPtr = Number((packed >> 32n) & 0xffff_ffffn);
      outLen = Number(packed & 0xffff_ffffn);
      const outBytes = new Uint8Array(this.exports.memory.buffer, outPtr, outLen);
      const jsonText = decoder.decode(outBytes);
      return JSON.parse(jsonText) as T;
    } finally {
      this.exports.sayso_dealloc(inPtr, inputBytes.length);
      if (outPtr !== 0 && outLen !== 0) {
        this.exports.sayso_dealloc(outPtr, outLen);
      }
    }
  }
}
