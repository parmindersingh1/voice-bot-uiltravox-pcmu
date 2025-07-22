// PCMUEncoder.ts
export class PCMUEncoder {
  static encode(input: Float32Array): Uint8Array {
    if (!input.every((sample) => sample >= -1 && sample <= 1)) {
      console.warn("Input samples should be in range [-1, 1]");
    }

    const output = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = this.linearToMuLaw(input[i] * 32767);
    }
    return output;
  }

  static decode(input: Uint8Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = this.muLawToLinear(input[i]) / 32767;
    }
    return output;
  }

  private static linearToMuLaw(sample: number): number {
    const MU = 255;
    const MAX = 32635; // Maximum linear PCM value for μ-law

    // Clip and scale input
    sample = Math.max(-MAX, Math.min(MAX, sample));
    const sign = sample < 0 ? 0x80 : 0;
    sample = Math.abs(sample);

    // Apply μ-law compression
    const biased = sample + 132; // Add bias
    if (biased < 132) {
      return sign | 0x7F; // Minimum value
    }

    // Compute exponent and mantissa
    const exponent = Math.floor(Math.log2(biased / (1 + MU)));
    const mantissa = Math.floor(biased / (2 ** (exponent + 5))) - 16;

    // Ensure exponent and mantissa are within valid ranges
    const finalExponent = Math.max(0, Math.min(exponent, 7));
    const finalMantissa = Math.max(0, Math.min(mantissa, 15));

    // Combine sign, exponent, and mantissa
    const muLaw = ~(sign | (finalExponent << 4) | finalMantissa);
    return muLaw & 0xFF;
  }

  private static muLawToLinear(sample: number): number {
    sample = ~sample;
    const sign = (sample & 0x80) ? -1 : 1;
    const exponent = (sample >> 4) & 0x07;
    const mantissa = sample & 0x0f;
    const value = (mantissa + 16) * (2 ** (exponent + 5)) - 132;
    return sign * value;
  }
}