import { Table2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

/** One line of a chart: a value per x of the chart's `xs`; `color` is normally a `--chart-series-*` token. */
export interface ChartSeries {
  key: string
  label: string
  color: string
  values: number[]
}

interface Props {
  /** Names the chart (and, with one series, the series): it is the only label a single-series chart gets. */
  title: string
  /** Whole seconds since the start, ascending. */
  xs: number[]
  /** The end of the x domain (e.g. the test's duration), so the line grows across a fixed axis. */
  xMax?: number
  series: ChartSeries[]
  /** The unit of the y values, for the accessible summary. */
  unit: string
  /** Formats a value for the axis-free readouts: tooltip and table. */
  format(value: number): string
  /** Fixed size in px; by default the width follows the container and the height is 200. */
  width?: number
  height?: number
}

const DEFAULT_WIDTH = 600
const DEFAULT_HEIGHT = 200
/** Room at the right for the end-of-line labels of a multi-series chart. */
const LABEL_ROOM = 44
const LABEL_GAP = 12

/** The plot area inside a `width` x `height` chart; `labelled` leaves room for the right-end labels. */
export function plotArea(
  width: number,
  height: number,
  labelled: boolean,
): { left: number; top: number; width: number; height: number } {
  const left = 44
  const top = 10
  const right = labelled ? LABEL_ROOM : 12
  const bottom = 22
  return { left, top, width: Math.max(1, width - left - right), height: Math.max(1, height - top - bottom) }
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `v`. */
function niceStep(v: number): number {
  const exp = 10 ** Math.floor(Math.log10(v))
  const f = v / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp
}

/** The top of the y axis for data peaking at `max`: a whole number of nice steps (about four). */
export function niceMax(max: number): number {
  const top = max > 0 && Number.isFinite(max) ? max : 1
  const step = niceStep(top / 4)
  return step * Math.max(1, Math.ceil(top / step - 1e-9))
}

const X_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]

const round = (n: number): number => Number(n.toFixed(2))
const tickText = (n: number): string => String(Number(n.toPrecision(4)))

/**
 * A hand-rolled SVG line chart of per-second data: 2px lines, a recessive grid, a crosshair tooltip over the whole
 * plot area (also by keyboard), and a Table toggle. Several series get a legend and a label at the end of each line.
 */
export function LineChart({ title, xs, xMax, series, unit, format, width, height }: Props): React.JSX.Element {
  const [measured, setMeasured] = useState(DEFAULT_WIDTH)
  const [table, setTable] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const titleId = useId()

  useEffect(() => {
    const el = wrapRef.current
    if (width !== undefined || !el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setMeasured(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [width, table])

  const W = width ?? measured
  const H = height ?? DEFAULT_HEIGHT
  const multi = series.length > 1
  const area = plotArea(W, H, multi)
  const last = xs.length > 0 ? xs[xs.length - 1]! : 0
  const xEnd = Math.max(1, xMax ?? 0, last)
  const peak = Math.max(0, ...series.flatMap((s) => s.values))
  const yTop = niceMax(peak)
  const xAt = (t: number): number => round(area.left + (t / xEnd) * area.width)
  const yAt = (v: number): number => round(area.top + area.height - (Math.min(v, yTop) / yTop) * area.height)

  const yTicks = [0, 1, 2, 3, 4].map((i) => (yTop * i) / 4)
  const xStep = X_STEPS.find((s) => xEnd / s <= 6) ?? 3600
  const xTicks: number[] = []
  for (let t = 0; t <= xEnd + 1e-9; t += xStep) xTicks.push(t)

  const index = hover !== null && hover < xs.length ? hover : null

  function nearest(svgX: number): number {
    let best = 0
    for (let i = 1; i < xs.length; i++) {
      if (Math.abs(xAt(xs[i]!) - svgX) < Math.abs(xAt(xs[best]!) - svgX)) best = i
    }
    return best
  }

  function onMove(e: React.MouseEvent): void {
    if (xs.length === 0) return
    const rect = svgRef.current?.getBoundingClientRect()
    const scale = rect && rect.width > 0 ? W / rect.width : 1
    setHover(nearest((e.clientX - (rect?.left ?? 0)) * scale))
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (xs.length === 0) return
    const lastIndex = xs.length - 1
    const at = index ?? lastIndex
    const next =
      e.key === 'ArrowLeft'
        ? Math.max(0, at - 1)
        : e.key === 'ArrowRight'
          ? Math.min(lastIndex, at + 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? lastIndex
              : null
    if (e.key === 'Escape') {
      setHover(null)
      return
    }
    if (next === null) return
    e.preventDefault()
    setHover(next)
  }

  // Right-end labels, nudged apart so they never overlap, kept inside the plot's height.
  const ends = multi
    ? series
        .filter((s) => s.values.length > 0)
        .map((s) => ({ key: s.key, label: s.label, y: yAt(s.values[s.values.length - 1]!) }))
        .sort((a, b) => a.y - b.y)
    : []
  for (let i = 1; i < ends.length; i++) ends[i]!.y = Math.max(ends[i]!.y, ends[i - 1]!.y + LABEL_GAP)
  const overflow = ends.length > 0 ? ends[ends.length - 1]!.y - (area.top + area.height) : 0
  if (overflow > 0) for (const end of ends) end.y -= overflow
  const endX = (s: ChartSeries): number => xAt(xs[Math.min(xs.length, s.values.length) - 1] ?? 0) + 6

  const summary =
    xs.length === 0
      ? `${title}: no data yet`
      : `${title}: ${xs.length} seconds; ` +
        series.map((s) => `${s.label} latest ${format(s.values[s.values.length - 1] ?? 0)} ${unit}`).join(', ')

  const tipLeft = index !== null ? xAt(xs[index]!) : 0
  const tipOnLeft = tipLeft > W / 2

  return (
    <figure className="chart" role="figure" aria-labelledby={titleId}>
      <div className="chart-head">
        <figcaption id={titleId} className="chart-title">
          {title}
        </figcaption>
        {multi && (
          <ul className="chart-legend" aria-label="Legend">
            {series.map((s) => (
              <li key={s.key} className="chart-legend-item">
                <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
              </li>
            ))}
          </ul>
        )}
        <span className="toolbar-spacer" />
        <button
          type="button"
          className="btn-text chart-toggle"
          aria-pressed={table}
          title={table ? 'Show the chart' : 'Show the data as a table'}
          onClick={() => setTable((t) => !t)}
        >
          <Table2 size={14} aria-hidden="true" />
          Table
        </button>
      </div>

      {table ? (
        <div className="chart-table-wrap">
          <table className="grid-table chart-table" aria-label={`${title} data`}>
            <thead>
              <tr>
                <th scope="col">Second</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {xs.map((t, i) => (
                <tr key={t}>
                  <td>{t}</td>
                  {series.map((s) => (
                    <td key={s.key}>{s.values[i] === undefined ? '' : format(s.values[i]!)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" ref={wrapRef}>
          <svg
            ref={svgRef}
            className="chart-svg"
            role="img"
            aria-label={summary}
            tabIndex={0}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            onKeyDown={onKeyDown}
            onBlur={() => setHover(null)}
          >
            <g className="chart-grid" aria-hidden="true">
              {yTicks.map((v) => (
                <g key={v}>
                  <line x1={area.left} x2={area.left + area.width} y1={yAt(v)} y2={yAt(v)} />
                  <text
                    className="chart-axis-label"
                    x={area.left - 6}
                    y={yAt(v)}
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {tickText(v)}
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <text
                  key={t}
                  className="chart-axis-label"
                  x={xAt(t)}
                  y={area.top + area.height + 15}
                  textAnchor={t === 0 ? 'start' : 'middle'}
                >
                  {`${t}s`}
                </text>
              ))}
            </g>
            {series.map((s) => {
              const n = Math.min(xs.length, s.values.length)
              if (n === 0) return null
              const d = Array.from({ length: n }, (_, i) => `${i === 0 ? 'M' : 'L'}${xAt(xs[i]!)},${yAt(s.values[i]!)}`)
              return (
                <g key={s.key}>
                  <path
                    data-series={s.key}
                    className="chart-line"
                    d={d.join(' ')}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    style={{ stroke: s.color }}
                  />
                  {n === 1 && <circle cx={xAt(xs[0]!)} cy={yAt(s.values[0]!)} r={2} style={{ fill: s.color }} />}
                </g>
              )
            })}
            {series.map((s) => {
              const end = ends.find((x) => x.key === s.key)
              if (!end) return null
              return (
                <text key={end.key} className="chart-end-label" x={endX(s)} y={end.y} dominantBaseline="middle">
                  {end.label}
                </text>
              )
            })}
            {index !== null && (
              <g aria-hidden="true">
                <line
                  className="chart-crosshair"
                  x1={tipLeft}
                  x2={tipLeft}
                  y1={area.top}
                  y2={area.top + area.height}
                />
                {series.map((s) =>
                  s.values[index] === undefined ? null : (
                    <circle
                      key={s.key}
                      className="chart-dot"
                      cx={tipLeft}
                      cy={yAt(s.values[index]!)}
                      r={3.5}
                      style={{ fill: s.color }}
                    />
                  ),
                )}
              </g>
            )}
            <rect
              className="chart-hit"
              x={area.left}
              y={area.top}
              width={area.width}
              height={area.height}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
          {xs.length === 0 && <p className="chart-empty muted">Waiting for data…</p>}
          {index !== null && (
            <div
              role="tooltip"
              className="chart-tip"
              style={{
                left: `${(tipLeft / W) * 100}%`,
                transform: tipOnLeft ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
                top: area.top,
              }}
            >
              <div className="chart-tip-head">{`${xs[index]} s`}</div>
              {series.map((s) =>
                s.values[index] === undefined ? null : (
                  <div key={s.key} className="chart-tip-row">
                    <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
                    <span className="chart-tip-label">{s.label}</span>
                    <span className="chart-tip-value">{format(s.values[index]!)}</span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </figure>
  )
}
