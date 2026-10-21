// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Highlighted,
  VarInput,
  VariableOptionsContext,
  VariablesContext,
} from '../../src/renderer/src/components/VarInput'
import type { Resolution } from '../../src/renderer/src/lib/variables'

afterEach(cleanup)

const OPTIONS: Resolution[] = [
  { name: 'baseUrl', value: 'http://localhost:3000', secret: false, source: 'environment', scopeName: 'Dev' },
  { name: 'token', value: 'hunter2-secret', secret: true, source: 'environment', scopeName: 'Dev' },
  { name: 'userBase', value: 'u', secret: false, source: 'collection', scopeName: 'Shop' },
  { name: 'region', value: 'eu', secret: false, source: 'globals', scopeName: 'Globals' },
]

const lookup = (name: string) => OPTIONS.find((o) => o.name === name) ?? null

function Field({ initial = '', onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <VariablesContext.Provider value={lookup}>
      <VariableOptionsContext.Provider value={OPTIONS}>
        <VarInput
          aria-label="URL"
          value={value}
          onChange={(v) => {
            setValue(v)
            onValue?.(v)
          }}
        />
      </VariableOptionsContext.Provider>
    </VariablesContext.Provider>
  )
}

const input = () => screen.getByRole('textbox', { name: 'URL' }) as HTMLInputElement
const names = () => screen.getAllByRole('option').map((o) => o.querySelector('.var-option-name')?.textContent)

describe('{{ completion in text inputs', () => {
  it('opens on {{ with every variable, marked as an autocompleting listbox', async () => {
    const user = userEvent.setup()
    render(<Field />)
    expect(input()).toHaveAttribute('aria-autocomplete', 'list')
    await user.type(input(), 'http://x/{{{{')
    // userEvent treats { as a key descriptor; {{ types one brace.
    expect(input()).toHaveValue('http://x/{{')
    const list = screen.getByRole('listbox', { name: 'Variables' })
    expect(names()).toEqual(['baseUrl', 'token', 'userBase', 'region'])
    expect(input()).toHaveAttribute('aria-controls', list.id)
    expect(input()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id)
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the value muted, secrets masked, and the source', async () => {
    const user = userEvent.setup()
    render(<Field />)
    await user.type(input(), '{{{{')
    const [base, token, user2, region] = screen.getAllByRole('option')
    expect(base.querySelector('.var-option-value')).toHaveTextContent('http://localhost:3000')
    expect(base.querySelector('.var-option-source')).toHaveTextContent('Environment')
    expect(token.querySelector('.var-option-value')).toHaveTextContent('••••')
    expect(token).not.toHaveTextContent('hunter2')
    expect(user2.querySelector('.var-option-source')).toHaveTextContent('Collection')
    expect(region.querySelector('.var-option-source')).toHaveTextContent('Globals')
  })

  it('filters by prefix, then by substring, and shows nothing without a match', async () => {
    const user = userEvent.setup()
    render(<Field />)
    await user.type(input(), '{{{{bas')
    expect(names()).toEqual(['baseUrl', 'userBase'])
    await user.type(input(), 'zz')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input()).not.toHaveAttribute('aria-activedescendant')
  })

  it('stays closed without {{ before the caret', async () => {
    const user = userEvent.setup()
    render(<Field />)
    await user.type(input(), 'x{{y{{')
    expect(input()).toHaveValue('x{y{')
    expect(screen.queryByRole('listbox')).toBeNull()
    // After a closed token.
    fireEvent.change(input(), { target: { value: '{{a}}' } })
    expect(input()).toHaveValue('{{a}}')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves the highlight with the arrows and inserts with Enter, replacing the prefix', async () => {
    const onValue = vi.fn()
    const user = userEvent.setup()
    render(<Field onValue={onValue} />)
    await user.type(input(), 'http://{{{{b')
    expect(names()).toEqual(['baseUrl', 'userBase'])
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    expect(input()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id)
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}{Enter}')
    expect(input()).toHaveValue('http://{{userBase}}')
    expect(input().selectionStart).toBe('http://{{userBase}}'.length)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('inserts with Tab, without adding a second }} when one follows the caret', async () => {
    const user = userEvent.setup()
    render(<Field initial="{{to}}/x" />)
    await user.click(input())
    input().setSelectionRange(4, 4)
    await user.type(input(), 'k', { initialSelectionStart: 4, initialSelectionEnd: 4 })
    expect(input()).toHaveValue('{{tok}}/x')
    expect(names()).toEqual(['token'])
    await user.keyboard('{Tab}')
    expect(input()).toHaveValue('{{token}}/x')
    expect(input().selectionStart).toBe('{{token}}'.length)
    expect(input()).toHaveFocus()
  })

  it('inserts the clicked option', async () => {
    const user = userEvent.setup()
    render(<Field />)
    await user.type(input(), 'a{{{{re')
    await user.click(screen.getByRole('option', { name: /region/ }))
    expect(input()).toHaveValue('a{{region}}')
    expect(input()).toHaveFocus()
  })

  it('closes with Escape and keeps the text', async () => {
    const user = userEvent.setup()
    render(<Field />)
    await user.type(input(), '{{{{ba')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input()).toHaveValue('{{ba')
    // Typing on opens it again.
    await user.type(input(), 's')
    expect(names()).toEqual(['baseUrl', 'userBase'])
  })

  it('closes when the input loses focus', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Field />
        <button type="button">elsewhere</button>
      </>,
    )
    await user.type(input(), '{{{{')
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('offers nothing without the options of a request', async () => {
    const user = userEvent.setup()
    function Bare() {
      const [value, setValue] = useState('')
      return <VarInput aria-label="URL" value={value} onChange={setValue} />
    }
    render(<Bare />)
    await user.type(input(), '{{{{')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input()).not.toHaveAttribute('aria-autocomplete')
  })
})

describe('variable chips', () => {
  it('take no space of their own (no padding, border or margin), so the caret matches the text', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync('src/renderer/src/styles.css', 'utf8')
    document.head.appendChild(style)
    try {
      render(
        <div className="var-input var-input-on">
          <div className="url-input var-mirror">
            <span className="var-run">
              <Highlighted text="http://{{baseUrl}}/{{nope}}" lookup={lookup} />
            </span>
          </div>
        </div>,
      )
      const chips = document.querySelectorAll<HTMLElement>('.var-token')
      expect(chips).toHaveLength(2)
      for (const chip of chips) {
        const cs = getComputedStyle(chip)
        for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
          expect(cs[`padding${side}`]).toBe('0px')
          expect(cs[`border${side}Width`]).toBe('0px')
          expect(cs[`margin${side}`]).toBe('0px')
        }
        expect(cs.boxShadow).toMatch(/^inset /)
      }
    } finally {
      style.remove()
    }
  })
})
