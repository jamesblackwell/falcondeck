import { providerMark } from '@falcondeck/client-core/provider-marks'

/* The same vendor marks the app shows next to each harness. Hermes has no
   mark in the app yet, so it is listed by name only. */
const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'agy', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'grok', label: 'Grok' },
  { id: 'pi', label: 'Pi' },
  { id: 'hermes', label: 'Hermes' },
]

function Mark({ id }: { id: string }) {
  const mark = providerMark(id)
  if (!mark) return null
  return (
    <svg viewBox={mark.viewBox} fill="currentColor" fillRule={mark.fillRule} aria-hidden="true">
      {mark.paths.map((path) => (
        <path key={path.d} d={path.d} fillOpacity={path.opacity} />
      ))}
    </svg>
  )
}

export function Harnesses() {
  return (
    <div className="harness-row" id="agents">
      <p className="harness-row__label">Works with</p>
      <ul className="harness-row__list">
        {HARNESSES.map(({ id, label }) => (
          <li key={id}>
            <Mark id={id} />
            {label}
          </li>
        ))}
        <li className="harness-row__more">+ any ACP agent</li>
      </ul>
    </div>
  )
}
