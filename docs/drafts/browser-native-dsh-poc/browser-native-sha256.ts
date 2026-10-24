const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}

function compress(state: Uint32Array, block: Uint8Array): void {
  const words = new Uint32Array(64)
  for (let wordIndex = 0; wordIndex < 16; wordIndex += 1) {
    const offset = wordIndex * 4
    words[wordIndex] = ((block[offset] ?? 0) << 24) | ((block[offset + 1] ?? 0) << 16)
      | ((block[offset + 2] ?? 0) << 8) | (block[offset + 3] ?? 0)
  }
  for (let wordIndex = 16; wordIndex < 64; wordIndex += 1) {
    const previous = words[wordIndex - 15] ?? 0
    const earlier = words[wordIndex - 2] ?? 0
    const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3)
    const sigma1 = rotateRight(earlier, 17) ^ rotateRight(earlier, 19) ^ (earlier >>> 10)
    words[wordIndex] = (words[wordIndex - 16] + sigma0 + words[wordIndex - 7] + sigma1) >>> 0
  }

  let first = state[0] ?? 0
  let second = state[1] ?? 0
  let third = state[2] ?? 0
  let fourth = state[3] ?? 0
  let fifth = state[4] ?? 0
  let sixth = state[5] ?? 0
  let seventh = state[6] ?? 0
  let eighth = state[7] ?? 0
  for (let round = 0; round < 64; round += 1) {
    const choice = (fifth & sixth) ^ (~fifth & seventh)
    const majority = (first & second) ^ (first & third) ^ (second & third)
    const sum1 = rotateRight(fifth, 6) ^ rotateRight(fifth, 11) ^ rotateRight(fifth, 25)
    const sum0 = rotateRight(first, 2) ^ rotateRight(first, 13) ^ rotateRight(first, 22)
    const temporary1 = (eighth + sum1 + choice + (ROUND_CONSTANTS[round] ?? 0) + (words[round] ?? 0)) >>> 0
    const temporary2 = (sum0 + majority) >>> 0
    eighth = seventh
    seventh = sixth
    sixth = fifth
    fifth = (fourth + temporary1) >>> 0
    fourth = third
    third = second
    second = first
    first = (temporary1 + temporary2) >>> 0
  }
  state[0] = (state[0] + first) >>> 0
  state[1] = (state[1] + second) >>> 0
  state[2] = (state[2] + third) >>> 0
  state[3] = (state[3] + fourth) >>> 0
  state[4] = (state[4] + fifth) >>> 0
  state[5] = (state[5] + sixth) >>> 0
  state[6] = (state[6] + seventh) >>> 0
  state[7] = (state[7] + eighth) >>> 0
}

/** Incremental SHA-256 accumulator for bounded-memory browser blob checks. */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly buffer = new Uint8Array(64)
  private bufferedBytes = 0
  private totalBytes = 0

  /**
   * Add one byte range to the digest.
   * @param bytes - Bytes to consume without retaining the caller's view.
   * @returns This accumulator.
   */
  update(bytes: Uint8Array): this {
    if (this.totalBytes > Number.MAX_SAFE_INTEGER - bytes.byteLength) {
      throw new RangeError('browser-native sha256: input is too large')
    }
    this.totalBytes += bytes.byteLength
    let offset = 0
    if (this.bufferedBytes > 0) {
      const copied = Math.min(64 - this.bufferedBytes, bytes.byteLength)
      this.buffer.set(bytes.subarray(0, copied), this.bufferedBytes)
      this.bufferedBytes += copied
      offset += copied
      if (this.bufferedBytes === 64) {
        compress(this.state, this.buffer)
        this.bufferedBytes = 0
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      compress(this.state, bytes.subarray(offset, offset + 64))
      offset += 64
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0)
      this.bufferedBytes = bytes.byteLength - offset
    }
    return this
  }

  /**
   * Return the digest without changing the accumulator.
   * @returns The 32-byte SHA-256 digest.
   */
  digest(): Uint8Array {
    const finalLength = (this.bufferedBytes + 9 + 63) & ~63
    const finalBlock = new Uint8Array(finalLength)
    finalBlock.set(this.buffer.subarray(0, this.bufferedBytes))
    finalBlock[this.bufferedBytes] = 0x80
    const bitLengthLow = (this.totalBytes % 0x20000000) * 8
    const bitLengthHigh = Math.floor(this.totalBytes / 0x20000000)
    const lengthOffset = finalLength - 8
    finalBlock[lengthOffset] = (bitLengthHigh >>> 24) & 0xff
    finalBlock[lengthOffset + 1] = (bitLengthHigh >>> 16) & 0xff
    finalBlock[lengthOffset + 2] = (bitLengthHigh >>> 8) & 0xff
    finalBlock[lengthOffset + 3] = bitLengthHigh & 0xff
    finalBlock[lengthOffset + 4] = (bitLengthLow >>> 24) & 0xff
    finalBlock[lengthOffset + 5] = (bitLengthLow >>> 16) & 0xff
    finalBlock[lengthOffset + 6] = (bitLengthLow >>> 8) & 0xff
    finalBlock[lengthOffset + 7] = bitLengthLow & 0xff

    const finalState = this.state.slice()
    for (let offset = 0; offset < finalBlock.byteLength; offset += 64) {
      compress(finalState, finalBlock.subarray(offset, offset + 64))
    }
    const output = new Uint8Array(32)
    for (let wordIndex = 0; wordIndex < finalState.length; wordIndex += 1) {
      const value = finalState[wordIndex] ?? 0
      const offset = wordIndex * 4
      output[offset] = value >>> 24
      output[offset + 1] = value >>> 16
      output[offset + 2] = value >>> 8
      output[offset + 3] = value
    }
    return output
  }

  /**
   * Return the digest as lowercase hexadecimal.
   * @returns The lowercase SHA-256 digest.
   */
  digestHex(): string {
    return [...this.digest()].map(value => value.toString(16).padStart(2, '0')).join('')
  }
}
