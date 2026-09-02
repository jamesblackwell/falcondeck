#!/usr/bin/env node
/**
 * Writes the two bundled turn-complete chimes as tiny 16-bit PCM WAVs.
 * macOS system sounds are played from /System/Library/Sounds and are not copied.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_RATE = 22050
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/sounds',
)

function render(durationSeconds, sampleAt) {
  const count = Math.round(SAMPLE_RATE * durationSeconds)
  const samples = new Float64Array(count)
  let peak = 0
  for (let i = 0; i < count; i += 1) {
    const t = i / SAMPLE_RATE
    const value = sampleAt(t, durationSeconds)
    samples[i] = value
    peak = Math.max(peak, Math.abs(value))
  }
  const gain = peak > 0 ? 0.72 / peak : 0
  const pcm = Buffer.alloc(count * 2)
  for (let i = 0; i < count; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i] * gain))
    pcm.writeInt16LE(Math.round(clipped * 32767), i * 2)
  }
  return pcm
}

function envelope(t, duration, attack = 0.008, release = 0.04) {
  if (t < 0) return 0
  const attackGain = Math.min(1, t / attack)
  const releaseStart = Math.max(attack, duration - release)
  const releaseGain = t >= releaseStart ? Math.max(0, (duration - t) / (duration - releaseStart)) : 1
  return attackGain * releaseGain
}

function partial(t, frequency, amplitude, tau) {
  return amplitude * Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / tau)
}

/** Bright two-note bell. Close to a struck glass, without copying Apple's sample. */
function chime(t, duration) {
  const env = envelope(t, duration, 0.006, 0.05)
  const first =
    partial(t, 1318.5, 1, 0.22) +
    partial(t, 2637.0, 0.28, 0.12) +
    partial(t, 1975.5, 0.18, 0.1)
  const secondT = t - 0.07
  const second =
    secondT < 0
      ? 0
      : partial(secondT, 987.8, 0.7, 0.28) + partial(secondT, 1975.5, 0.16, 0.14)
  return env * (first + second)
}

/** Descending fourth. Softer "that's done" cue. */
function drop(t, duration) {
  const env = envelope(t, duration, 0.01, 0.06)
  const first = partial(t, 784.0, 1, 0.2) + partial(t, 1568.0, 0.22, 0.1)
  const secondT = t - 0.09
  const second =
    secondT < 0
      ? 0
      : partial(secondT, 523.25, 0.85, 0.32) + partial(secondT, 1046.5, 0.18, 0.16)
  return env * (first + second)
}

function wavBuffer(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const sounds = [
  { file: 'chime.wav', duration: 0.48, sampleAt: chime },
  { file: 'drop.wav', duration: 0.52, sampleAt: drop },
]

await mkdir(OUT_DIR, { recursive: true })
for (const sound of sounds) {
  const buffer = wavBuffer(render(sound.duration, sound.sampleAt))
  const target = path.join(OUT_DIR, sound.file)
  await writeFile(target, buffer)
  console.log(`${sound.file}\t${buffer.length} bytes`)
}
