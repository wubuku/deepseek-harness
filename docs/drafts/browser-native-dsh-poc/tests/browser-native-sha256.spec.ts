import { describe, expect, it } from 'vitest'
import { Sha256 } from '../browser-native-sha256.ts'

function digestInChunks(value: Uint8Array, chunkBytes: number): string {
  const digest = new Sha256()
  for (let offset = 0; offset < value.byteLength; offset += chunkBytes) {
    digest.update(value.subarray(offset, Math.min(offset + chunkBytes, value.byteLength)))
  }
  return digest.digestHex()
}

describe('Browser-Native incremental SHA-256', () => {
  it('matches the standard empty and text vectors', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(digestInChunks(new TextEncoder().encode('abc'), 1)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('keeps the digest stable and handles input larger than one block', () => {
    const value = new Uint8Array(1_000_000).fill(0x61)
    const digest = new Sha256().update(value)
    expect(digest.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
    expect(digest.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })
})
