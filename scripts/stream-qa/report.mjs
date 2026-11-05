#!/usr/bin/env node
// Prints one row per recording: node scripts/stream-qa/report.mjs <glob-prefix>
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[3] ?? '/tmp/fd-stream-qa'
const prefix = process.argv[2] ?? ''
const rows = readdirSync(dir)
  .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
  .sort()
  .map((name) => {
    const r = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
    return {
      run: name.replace('.json', ''),
      wheels: `${r.wheelEvents}/${r.wheelsSent}`,
      'up leaps': r.upwardLeaps,
      'max leap': r.maxUpwardLeapPx,
      'moved': r.parked.framesMoved,
      'drift px': r.parked.totalPx,
      'max step': r.parked.maxStepPx,
      'blk jumps': r.gesture.blockJumps,
      'max blk': r.gesture.maxBlockJumpPx,
      'paints/s': r.streaming.paintsPerSecond,
      'chars/paint': r.streaming.meanCharsPerPaint,
      'max chars': r.streaming.maxCharsPerPaint,
      'h step max': r.streaming.maxHeightStepPx,
      'solo gap': r.following.maxDistanceUnattended,
      'return gap': r.following.maxDistanceAfterReturn,
      'p50 ms': r.frames.p50,
      'p95 ms': r.frames.p95,
      'max ms': r.frames.max,
      '>25ms': r.frames.over25ms,
      '>50ms': r.frames.over50ms,
    }
  })
console.table(rows)
