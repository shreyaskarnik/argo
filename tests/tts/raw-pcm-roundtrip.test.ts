/**
 * The one thing `raw-pcm.test.ts` cannot check: whether the demuxer argv it
 * asserts actually decodes the bytes Gemini sends.
 *
 * Every test there stubs `execFileSync`, so they compare the string 's16le'
 * against the source that produced it and would pass just as happily if the
 * correct answer were 's16be'. Endianness is the one genuinely uncertain
 * decision in the decode fix: RFC 2586 defines L16 as network byte order and
 * Google sends little-endian anyway, so the code deliberately contradicts the
 * spec. Getting it wrong does not raise. It returns full-scale noise at exit
 * 0, and argo derives scene durations from clip length, so the recording is
 * still built around it.
 *
 * A synthesized sine is what makes that falsifiable. Byte-swapped 16-bit
 * samples are not quiet noise, they are near-full-scale, so peak amplitude
 * separates a correct decode from a wrong one by a wide margin.
 */
import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { convertToWav, parseRawAudioMime, parseWavHeader } from '../../src/tts/engine.js';
import { describeWithCapability } from '../helpers/capability.js';

const execFileP = promisify(execFile);

// CI installs ffmpeg deliberately, so a miss there means the workflow drifted
// rather than that the host is bare, and this is the one test that decodes
// real audio rather than asserting argv.
let hasFfmpeg = false;
try {
  await execFileP('ffmpeg', ['-version']);
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

/** A mono s16le sine, the shape Gemini's TTS models return. */
function sineS16LE(samples: number, sampleRate: number, hz: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // 0.25 full scale, chosen so a byte swap lands far outside it.
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.25 * 32767);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

/** Peak absolute amplitude of a mono float32 WAV, as a fraction of full scale. */
function peakAmplitude(wav: Buffer): number {
  const { dataOffset, dataSize } = parseWavHeader(wav);
  // convertToWav writes 0xFFFFFFFF as the data size (a known ffmpeg-pipe
  // quirk recorded in CLAUDE.md), so trust the buffer rather than the header.
  const end = Math.min(wav.length, dataOffset + dataSize);
  let peak = 0;
  for (let i = dataOffset; i + 4 <= end; i += 4) {
    peak = Math.max(peak, Math.abs(wav.readFloatLE(i)));
  }
  return peak;
}

describeWithCapability(hasFfmpeg, 'an ffmpeg binary')('raw PCM survives a real ffmpeg conversion', () => {
  const RATE = 16000;
  const SAMPLES = RATE / 2; // 0.5s, deliberately not the 24kHz output rate

  it('decodes a Gemini-shaped L16 response to the amplitude it was given', () => {
    const pcm = sineS16LE(SAMPLES, RATE, 440);
    const format = parseRawAudioMime(`audio/L16;codec=pcm;rate=${RATE}`);

    const wav = convertToWav(pcm, 1, format);
    const header = parseWavHeader(wav);

    // Output contract: mono float32 at 24kHz regardless of what came in.
    expect(header.sampleRate).toBe(24000);
    expect(header.numChannels).toBe(1);
    expect(header.audioFormat).toBe(3);

    // The real assertion. A correct s16le decode reproduces the 0.25 peak;
    // reading the same bytes as s16be scrambles the high and low byte of
    // every sample and lands near full scale instead.
    const peak = peakAmplitude(wav);
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(0.35);
  });

  it('reads the RFC byte order as near full-scale noise', () => {
    // Pins the deviation as a deliberate one. If a future edit "corrects"
    // s16le to s16be to match the RFC, the test above goes red and this one
    // says why: the same bytes read big-endian are not quietly wrong, they
    // are loud.
    const pcm = sineS16LE(SAMPLES, RATE, 440);

    const asBigEndian = convertToWav(pcm, 1, { format: 's16be', sampleRate: RATE, channels: 1 });

    expect(peakAmplitude(asBigEndian)).toBeGreaterThan(0.9);
  });

  it('honours the rate from the media type rather than assuming 24kHz', () => {
    // A wrong rate does not error, it resamples: declaring 24000 for a 16000
    // stream yields a clip two thirds the length at 1.5x pitch. Duration is
    // the observable, and argo builds every wait in the recording from it.
    const pcm = sineS16LE(SAMPLES, RATE, 440);

    const correct = convertToWav(pcm, 1, parseRawAudioMime(`audio/L16;rate=${RATE}`));
    const wrong = convertToWav(pcm, 1, parseRawAudioMime('audio/L16;rate=24000'));

    expect(parseWavHeader(correct).durationMs).toBeGreaterThan(450);
    expect(parseWavHeader(correct).durationMs).toBeLessThan(550);
    expect(parseWavHeader(wrong).durationMs).toBeLessThan(400);
  });
});
