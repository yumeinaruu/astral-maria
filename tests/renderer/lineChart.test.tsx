// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { LineChart, niceMax, plotArea, type ChartSeries } from '../../src/renderer/src/components/load/LineChart'

afterEach(cleanup)

const W = 600
const H = 200

const throughput: ChartSeries[] = [
  { key: 'rps', label: 'Requests/s', color: 'var(--chart-series-1)', values: [0, 5, 10] },
]

const latency: ChartSeries[] = [
  { key: 'p50', label: 'p50', color: 'var(--chart-series-1)', values: [2, 3, 4] },
  { key: 'p95', label: 'p95', color: 'var(--chart-series-2)', values: [5, 6, 7] },
  { key: 'p99', label: 'p99', color: 'var(--chart-series-3)', values: [8, 9, 10] },
]

function chart(series: ChartSeries[], title = 'Throughput') {
  return render(
    <LineChart
      title={title}
      xs={[0, 1, 2]}
      series={series}
      unit={series.length > 1 ? 'ms' : 'req/s'}
      format={(v) => `${v}`}
      width={W}
      height={H}
    />,
  )
}

function pathOf(container: HTMLElement, key: string): string {
  return container.querySelector(`path[data-series="${key}"]`)?.getAttribute('d') ?? ''
}

describe('LineChart', () => {
  it('maps the data to the viewBox', () => {
    const { container } = chart(throughput)
    const svg = container.querySelector('svg.chart-svg')!
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${W} ${H}`)
    const area = plotArea(W, H, false)
    expect(niceMax(10)).toBe(10)
    const y = (v: number) => +(area.top + area.height - (v / 10) * area.height).toFixed(2)
    const x = (t: number) => +(area.left + (t / 2) * area.width).toFixed(2)
    expect(pathOf(container, 'rps')).toBe(`M${x(0)},${y(0)} L${x(1)},${y(5)} L${x(2)},${y(10)}`)
  })

  it('draws 2px lines in the series colour', () => {
    const { container } = chart(latency, 'Latency')
    const line = container.querySelector('path[data-series="p95"]') as SVGPathElement
    expect(line.style.stroke).toBe('var(--chart-series-2)')
    expect(line.getAttribute('stroke-width')).toBe('2')
  })

  it('has no legend for one series, the title naming it', () => {
    chart(throughput)
    expect(screen.getByRole('figure', { name: 'Throughput' })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull()
  })

  it('has a legend and a label at the right end of each line for several series', () => {
    const { container } = chart(latency, 'Latency')
    const legend = screen.getByRole('list', { name: 'Legend' })
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['p50', 'p95', 'p99'])
    const labels = [...container.querySelectorAll('text.chart-end-label')]
    expect(labels.map((l) => l.textContent)).toEqual(['p50', 'p95', 'p99'])
    const area = plotArea(W, H, true)
    for (const l of labels) expect(Number(l.getAttribute('x'))).toBeGreaterThan(area.left + area.width)
  })

  it('shows no end labels on a single-series chart', () => {
    const { container } = chart(throughput)
    expect(container.querySelectorAll('text.chart-end-label')).toHaveLength(0)
  })

  it('shows a crosshair tooltip with the second and every series value on hover', () => {
    const { container } = chart(latency, 'Latency')
    const svg = container.querySelector('svg.chart-svg')!
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON() {} }) as DOMRect
    const area = plotArea(W, H, true)
    const hit = container.querySelector('.chart-hit')!
    expect(Number(hit.getAttribute('width'))).toBe(area.width)
    expect(Number(hit.getAttribute('height'))).toBe(area.height)
    fireEvent.mouseMove(hit, { clientX: area.left + area.width / 2 + 3, clientY: 50 })
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('1 s')
    expect(tip).toHaveTextContent('p503')
    expect(tip).toHaveTextContent('p956')
    expect(tip).toHaveTextContent('p999')
    expect(container.querySelector('.chart-crosshair')).not.toBeNull()
    fireEvent.mouseLeave(hit)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('moves the crosshair with the arrow keys', () => {
    chart(throughput)
    const plot = screen.getByRole('img', { name: /Throughput/ })
    fireEvent.keyDown(plot, { key: 'End' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('2 s')
    fireEvent.keyDown(plot, { key: 'ArrowLeft' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('1 s')
  })

  it('toggles a table of the per-second data', () => {
    const { container } = chart(latency, 'Latency')
    const toggle = screen.getByRole('button', { name: 'Table' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const table = screen.getByRole('table', { name: 'Latency data' })
    const rows = within(table).getAllByRole('row')
    expect(rows.map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['Second', 'p50', 'p95', 'p99'],
      ['0', '2', '5', '8'],
      ['1', '3', '6', '9'],
      ['2', '4', '7', '10'],
    ])
    expect(container.querySelector('svg.chart-svg')).toBeNull()
    fireEvent.click(toggle)
    expect(container.querySelector('svg.chart-svg')).not.toBeNull()
  })

  it('says so when there is no data yet', () => {
    render(
      <LineChart title="Throughput" xs={[]} series={[{ ...throughput[0]!, values: [] }]} unit="req/s" format={String} />,
    )
    expect(screen.getByText('Waiting for data…')).toBeVisible()
  })
})
