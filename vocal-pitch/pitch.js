/* YIN fundamental-frequency tracker (de Cheveigné & Kawahara, 2002).
   The difference function is computed with an FFT autocorrelation so a
   whole song can be analyzed in the browser. Frames without a clear
   period — noise, breaths, silence — are reported as unvoiced. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.Pitch = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MIN_FREQ = 65;
  const MAX_FREQ = 1400;
  const YIN_THRESHOLD = 0.15;
  const TARGET_RATE = 16000;

  function makeFft(n) {
    const bitrev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let y = 0;
      for (let k = 1; k < n; k <<= 1) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      bitrev[i] = y;
    }

    const levels = [];
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const re = new Float32Array(half);
      const im = new Float32Array(half);
      for (let j = 0; j < half; j++) {
        const angle = (-2 * Math.PI * j) / len;
        re[j] = Math.cos(angle);
        im[j] = Math.sin(angle);
      }
      levels.push({ len, half, re, im });
    }

    function transform(reOut, imOut, inverse) {
      for (let i = 0; i < n; i++) {
        const j = bitrev[i];
        if (j > i) {
          const tr = reOut[i];
          reOut[i] = reOut[j];
          reOut[j] = tr;
          const ti = imOut[i];
          imOut[i] = imOut[j];
          imOut[j] = ti;
        }
      }

      for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
        const level = levels[levelIndex];
        const len = level.len;
        const half = level.half;
        const wr = level.re;
        const wi = level.im;
        for (let i = 0; i < n; i += len) {
          for (let j = 0; j < half; j++) {
            const wRe = wr[j];
            const wIm = inverse ? -wi[j] : wi[j];
            const aRe = reOut[i + j];
            const aIm = imOut[i + j];
            const bRe = reOut[i + j + half];
            const bIm = imOut[i + j + half];
            const vRe = bRe * wRe - bIm * wIm;
            const vIm = bRe * wIm + bIm * wRe;
            reOut[i + j] = aRe + vRe;
            imOut[i + j] = aIm + vIm;
            reOut[i + j + half] = aRe - vRe;
            imOut[i + j + half] = aIm - vIm;
          }
        }
      }

      if (inverse) {
        const scale = 1 / n;
        for (let i = 0; i < n; i++) {
          reOut[i] *= scale;
          imOut[i] *= scale;
        }
      }
    }

    return { n, transform };
  }

  function lowpassInPlace(samples, sampleRate, cutoff) {
    const nyquist = sampleRate * 0.5;
    const freq = Math.min(cutoff, nyquist * 0.9);
    const q = Math.SQRT1_2;
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * q);
    const b0 = (1 - cos) / 2;
    const b1 = 1 - cos;
    const b2 = (1 - cos) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    const nb0 = b0 / a0;
    const nb1 = b1 / a0;
    const nb2 = b2 / a0;
    const na1 = a1 / a0;
    const na2 = a2 / a0;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      samples[i] = y0;
    }
  }

  function resample(input, inRate, outRate) {
    if (Math.abs(inRate - outRate) < 1) {
      return input;
    }
    const filtered = new Float32Array(input);
    if (outRate < inRate) {
      const cutoff = outRate * 0.45;
      lowpassInPlace(filtered, inRate, cutoff);
      lowpassInPlace(filtered, inRate, cutoff);
    }
    const ratio = inRate / outRate;
    const outLen = Math.max(0, Math.floor((filtered.length - 1) / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = filtered[index];
      const b = filtered[index + 1];
      out[i] = a + (b - a) * fraction;
    }
    return out;
  }

  function chooseW(sampleRate) {
    const maxLag = Math.ceil(sampleRate / MIN_FREQ) + 8;
    let w = 256;
    while (w < maxLag) w *= 2;
    if (w < 512 && sampleRate >= 12000) w = 512;
    if (w > 1024) w = 1024;
    return w;
  }

  function createTracker(sampleRate) {
    const w = chooseW(sampleRate);
    const frameLen = w * 2;
    const fft = makeFft(w * 4);
    const arRe = new Float32Array(fft.n);
    const arIm = new Float32Array(fft.n);
    const bRe = new Float32Array(fft.n);
    const bIm = new Float32Array(fft.n);
    const frame = new Float32Array(frameLen);
    const cmndf = new Float64Array(w);
    const maxFreq = Math.min(MAX_FREQ, sampleRate * 0.45);
    const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    const tauMax = Math.min(w - 2, Math.ceil(sampleRate / MIN_FREQ));

    function detect(samples, offset) {
      let mean = 0;
      for (let i = 0; i < frameLen; i++) mean += samples[offset + i];
      mean /= frameLen;

      arRe.fill(0);
      arIm.fill(0);
      bRe.fill(0);
      bIm.fill(0);

      let prefix = 0;
      const prefixAt = new Float64Array(frameLen + 1);
      for (let i = 0; i < frameLen; i++) {
        const value = samples[offset + i] - mean;
        frame[i] = value;
        prefix += value * value;
        prefixAt[i + 1] = prefix;
      }

      for (let i = 0; i < w; i++) arRe[i] = frame[w - 1 - i];
      for (let i = 0; i < frameLen; i++) bRe[i] = frame[i];

      fft.transform(arRe, arIm, false);
      fft.transform(bRe, bIm, false);
      for (let i = 0; i < fft.n; i++) {
        const a = arRe[i];
        const b = arIm[i];
        const c = bRe[i];
        const d = bIm[i];
        arRe[i] = a * c - b * d;
        arIm[i] = a * d + b * c;
      }
      fft.transform(arRe, arIm, true);

      const sumLeft = prefixAt[w];
      cmndf[0] = 1;
      let running = 0;
      let tauEstimate = -1;
      let bestDepth = 1;

      for (let tau = 1; tau <= tauMax; tau++) {
        const sumRight = prefixAt[tau + w] - prefixAt[tau];
        const correlation = arRe[tau + w - 1];
        let difference = sumLeft + sumRight - 2 * correlation;
        if (difference < 0) difference = 0;
        running += difference;
        const normalized = running > 0 ? (difference * tau) / running : 1;
        cmndf[tau] = normalized;
      }

      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cmndf[tau] < YIN_THRESHOLD) {
          while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
          tauEstimate = tau;
          bestDepth = cmndf[tau];
          break;
        }
      }

      if (tauEstimate < 0) return 0;

      // If the lower octave is a clearly deeper valley, the first dip was a harmonic.
      const lower = Math.round(tauEstimate * 2);
      if (lower > tauEstimate && lower < tauMax) {
        let valley = lower;
        const from = Math.max(tauEstimate + 1, lower - 2);
        const to = Math.min(tauMax - 1, lower + 2);
        for (let tau = from; tau <= to; tau++) {
          if (cmndf[tau] < cmndf[valley]) valley = tau;
        }
        const isMinimum = cmndf[valley] <= cmndf[valley - 1] && cmndf[valley] <= cmndf[valley + 1];
        if (isMinimum && cmndf[valley] + 0.02 < bestDepth && cmndf[valley] < YIN_THRESHOLD) {
          tauEstimate = valley;
          bestDepth = cmndf[valley];
        }
      }

      let betterTau = tauEstimate;
      if (tauEstimate > 0 && tauEstimate < tauMax) {
        const s0 = cmndf[tauEstimate - 1];
        const s1 = cmndf[tauEstimate];
        const s2 = cmndf[tauEstimate + 1];
        const denom = 2 * (2 * s1 - s2 - s0);
        if (denom !== 0) betterTau = tauEstimate + (s2 - s0) / denom;
      }

      if (!(betterTau > 0)) return 0;
      const frequency = sampleRate / betterTau;
      if (frequency < MIN_FREQ || frequency > maxFreq) return 0;
      return frequency;
    }

    return {
      frameLen,
      hop: Math.max(1, Math.round(sampleRate * 0.01)),
      detect,
      frameRms(samples, offset) {
        let energy = 0;
        for (let i = 0; i < frameLen; i++) {
          const value = samples[offset + i];
          energy += value * value;
        }
        return Math.sqrt(energy / frameLen);
      },
    };
  }

  function rmsGate(rmsValues) {
    const sorted = Array.from(rmsValues);
    sorted.sort((a, b) => a - b);
    const start = Math.floor(sorted.length * 0.8);
    let sum = 0;
    const count = Math.max(1, sorted.length - start);
    for (let i = start; i < sorted.length; i++) sum += sorted[i];
    return Math.max(0.0008, (sum / count) * 0.07);
  }

  function midiToHz(midi) {
    return 440 * 2 ** ((midi - 69) / 12);
  }

  function hzToMidi(hz) {
    return 69 + 12 * Math.log2(hz / 440);
  }

  function postProcess(freqs) {
    const n = freqs.length;
    const midi = new Float64Array(n);
    const voiced = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (freqs[i] > 0) {
        midi[i] = hzToMidi(freqs[i]);
        voiced[i] = 1;
      }
    }

    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      const votes = [];
      for (let k = i - 4; k <= i + 4; k++) {
        if (k !== i && k >= 0 && k < n && voiced[k]) votes.push(midi[k]);
      }
      if (votes.length < 3) continue;
      votes.sort((a, b) => a - b);
      const median = votes[votes.length >> 1];
      const delta = midi[i] - median;
      if (delta > 10.5 && delta < 13.5) midi[i] -= 12;
      else if (delta < -10.5 && delta > -13.5) midi[i] += 12;
    }

    const keep = new Uint8Array(voiced);
    for (let i = 0; i < n; i++) {
      if (!voiced[i]) continue;
      let near = 0;
      for (let k = 1; k <= 2; k++) {
        if (i - k >= 0 && voiced[i - k] && Math.abs(midi[i - k] - midi[i]) < 3) near++;
        if (i + k < n && voiced[i + k] && Math.abs(midi[i + k] - midi[i]) < 3) near++;
      }
      if (near === 0) keep[i] = 0;
    }

    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      const window = [];
      for (let k = i - 2; k <= i + 2; k++) {
        if (k >= 0 && k < n && keep[k]) window.push(midi[k]);
      }
      window.sort((a, b) => a - b);
      const median = window[window.length >> 1];
      const delta = Math.abs(median - midi[i]);
      if (delta > 7) continue;
      const chosen = delta > 0.65 ? median : midi[i];
      out[i] = midiToHz(chosen);
    }

    for (let i = 1; i < n - 1; i++) {
      if (out[i] === 0 && out[i - 1] > 0 && out[i + 1] > 0) {
        const a = hzToMidi(out[i - 1]);
        const b = hzToMidi(out[i + 1]);
        if (Math.abs(a - b) < 0.8) out[i] = midiToHz((a + b) / 2);
      }
    }

    let runStart = -1;
    const dropRun = (end) => {
      if (runStart >= 0 && end - runStart < 3) {
        for (let i = runStart; i < end; i++) out[i] = 0;
      }
      runStart = -1;
    };
    for (let i = 0; i < n; i++) {
      if (out[i] > 0) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        dropRun(i);
      }
    }
    dropRun(n);
    return out;
  }

  async function analyze(mono, sampleRate, onProgress) {
    const duration = mono.length / sampleRate;
    const targetRate = sampleRate > TARGET_RATE ? TARGET_RATE : sampleRate;
    const samples = resample(mono, sampleRate, targetRate);
    const tracker = createTracker(targetRate);
    const { frameLen, hop } = tracker;
    const empty = {
      duration,
      hop: hop / targetRate,
      times: new Float32Array(0),
      freqs: new Float32Array(0),
    };
    if (samples.length < frameLen || tauRangeInvalid(targetRate)) return empty;

    const frameCount = Math.floor((samples.length - frameLen) / hop) + 1;
    const times = new Float32Array(frameCount);
    const raw = new Float32Array(frameCount);
    const rms = new Float32Array(frameCount);

    for (let index = 0; index < frameCount; index++) {
      const offset = index * hop;
      times[index] = (offset + frameLen / 2) / targetRate;
      rms[index] = tracker.frameRms(samples, offset);
    }

    const gate = rmsGate(rms);
    for (let index = 0; index < frameCount; index++) {
      if (rms[index] >= gate) raw[index] = tracker.detect(samples, index * hop);
      if (onProgress && (index & 63) === 0) {
        onProgress(index / frameCount);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (onProgress) onProgress(1);

    return {
      duration,
      hop: hop / targetRate,
      times,
      freqs: postProcess(raw),
    };
  }

  function tauRangeInvalid(sampleRate) {
    const w = chooseW(sampleRate);
    const maxFreq = Math.min(MAX_FREQ, sampleRate * 0.45);
    const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    const tauMax = Math.min(w - 2, Math.ceil(sampleRate / MIN_FREQ));
    return tauMax <= tauMin + 1;
  }

  return { analyze };
});
