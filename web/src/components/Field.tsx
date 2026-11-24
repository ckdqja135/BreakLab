import { useEffect, useState } from 'react'

interface Props { label: string; value: number; min: number; max: number; step?: number; onChange: (n: number) => void; disabled?: boolean; hint?: string }

export function Num({ label, value, min, max, step, onChange, disabled, hint }: Props) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Math.round(Number(text))
    const v = Number.isFinite(n) && text !== '' ? Math.min(max, Math.max(min, n)) : value
    setText(String(v))
    onChange(v)
  }
  return (
    <label className="num">
      <span>{label}</span>
      <input type="number" inputMode="numeric" value={text} min={min} max={max} step={step} disabled={disabled} title={`${min}에서 ${max}`}
        onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value && n >= min && n <= max) onChange(Math.round(n)) }} onBlur={commit} />
      {hint && <small>{hint}</small>}
    </label>
  )
}
