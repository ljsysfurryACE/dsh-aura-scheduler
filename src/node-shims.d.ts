// Minimal ambient types for Node built-ins used by aura-scheduler v2.
// Full @types/node is not bundled; only the APIs we touch are declared.
declare module 'node:fs/promises' {
  export interface Stats { size: number }
  export function stat(path: string): Promise<Stats>
  export function readFile(path: string, encoding: string): Promise<string>
}
declare module 'node:child_process' {
  export function exec(cmd: string, cb: (err: Error | null, stdout: string) => void): void
}
declare module 'node:net' {
  export function createConnection(options: { host: string; port: number }): {
    destroy(): void; setTimeout(ms: number): void
    once(ev: 'connect' | 'timeout' | 'error', cb: () => void): void
  }
}
declare module 'node:crypto' {
  export function createHmac(alg: string, key: string): { update(data: string): { digest(enc: string): string } }
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
}
