// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** In-memory Web Storage: Node 25 has its own experimental localStorage that hides jsdom's. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

// CodeMirror measures text; jsdom has no layout
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true })
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  document.elementFromPoint = () => null
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('mapper.language', 'en')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetModules()
})

async function renderApp() {
  // A fresh module: the startup state (handoff, saved work) is read once per page
  const { default: App } = await import('./App.tsx')
  const { I18nProvider } = await import('./i18n/I18nProvider.tsx')
  render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  )
}

const codeText = () => document.querySelector('.code-panel__editor .cm-content')?.textContent ?? ''

describe('Mapper', () => {
  it('explains what to do before there is any input', async () => {
    await renderApp()
    expect(screen.getByRole('heading', { name: 'Mapper' })).toBeTruthy()
    expect(screen.getByText(/Paste or open the source and the target, or load an example/)).toBeTruthy()
    expect(screen.getAllByText('Paste or open a model to start.')).toHaveLength(2)
  })

  it('loads an example, suggests relations and generates code', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Simple mapping' }))
    const relations = await screen.findByRole('region', { name: 'UserDto → User' })
    expect(within(relations).getByText('emailAddress')).toBeTruthy()
    await waitFor(() => expect(codeText()).toContain('export function mapUserDtoToUser(source: UserDto): User'))
    expect(codeText()).toContain('email: source.emailAddress')
  })

  it('accepts suggestions, edits a field, and undoes and redoes', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Transformations' }))
    const accept = await screen.findByRole('button', { name: 'Accept the suggestion for “active”' })
    fireEvent.click(accept)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept the suggestion for “active”' })).toBeNull())
    await waitFor(() => expect(codeText()).toContain('active=source.status == ProductStatus.Active'))

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept the suggestion for “active”' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept the suggestion for “active”' })).toBeNull())

    // A constant through the field editor
    fireEvent.click(screen.getByRole('button', { name: 'Edit the relation of “sku”' }))
    const editor = screen.getByRole('group', { name: /Relation of “sku”/ })
    fireEvent.change(within(editor).getByLabelText('Transformation'), { target: { value: 'constant' } })
    fireEvent.change(within(screen.getByRole('group', { name: /Relation of “sku”/ })).getByLabelText('Value'), {
      target: { value: 'SKU-0' },
    })
    await waitFor(() => expect(codeText()).toContain('sku="SKU-0"'))
  })

  it('creates the target model from the source', async () => {
    await renderApp()
    const create = () => screen.getByRole('button', { name: 'Create', expanded: false })
    // Without a source there is nothing to start from
    expect((create() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Simple mapping' }))
    await screen.findByRole('region', { name: 'UserDto → User' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[1])
    await waitFor(() => expect((create() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(create())
    const form = screen.getByRole('region', { name: 'Create the target model' })
    fireEvent.change(within(form).getByLabelText('Format of the new model'), { target: { value: 'python' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }))
    expect(await screen.findByText(/Target model “User” created from “UserDto”/)).toBeTruthy()
    const relations = await screen.findByRole('region', { name: 'UserDto → User' })
    expect(relations.querySelectorAll('.mapping__row--mapped')).toHaveLength(6)
    // The output language stays the one chosen: the model's format and the mapper's language are separate
    await waitFor(() => expect(codeText()).toContain('export function mapUserDtoToUser(source: UserDto): User'))
  })

  it('filters the fields to review and searches', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Transformations' }))
    await screen.findByRole('region', { name: 'ProductResponse → ProductModel' })
    fireEvent.click(screen.getByRole('button', { name: 'To review' }))
    const section = screen.getByRole('region', { name: 'ProductResponse → ProductModel' })
    expect([...section.querySelectorAll('.mapping__row .mapping__target-name')].map((item) => item.textContent)).toEqual([
      'active',
      'created_at',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.change(screen.getByLabelText('Find a field'), { target: { value: 'stock' } })
    expect([...section.querySelectorAll('.mapping__row .mapping__target-name')].map((item) => item.textContent)).toEqual(['stock'])
  })

  it('switches the interface language', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'ES' }))
    expect(screen.getAllByText('Pega o abre un modelo para empezar.')).toHaveLength(2)
    expect(localStorage.getItem('lang')).toBe('es')
  })

  it('opens a model sent by Api2Class as the source', async () => {
    sessionStorage.setItem(
      'mapper.incoming',
      JSON.stringify({
        format: 'model-handoff',
        version: 1,
        from: 'api2class',
        role: 'source',
        model: 'Root',
        schema: {
          format: 'model-schema',
          version: 1,
          models: [
            {
              name: 'Root',
              kind: 'object',
              fields: [{ name: 'id', type: { kind: 'primitive', name: 'integer' }, nullable: false, optional: false }],
            },
          ],
          enums: [],
        },
      }),
    )
    await renderApp()
    expect(await screen.findByText(/Model received from Api2Class/)).toBeTruthy()
    expect(sessionStorage.getItem('mapper.incoming')).toBeNull()
  })

  it('sends the target model with its text to Model2DB, after confirming', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Simple mapping' }))
    await screen.findByRole('region', { name: 'UserDto → User' })
    // jsdom does not navigate: the handoff left for Model2DB is what is checked
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Open in Model2DB' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Model2DB opens in this tab'))
    const handoff = JSON.parse(sessionStorage.getItem('model2db.incoming')!)
    expect(handoff).toMatchObject({ format: 'model-handoff', from: 'mapper', role: 'target', model: 'User' })
    expect(handoff.text.format).toBe('typescript')
    expect(handoff.text.content).toContain('export interface User')
  })

  it('remembers the work only when asked, and deletes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Simple mapping' }))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(localStorage.getItem('mapper.workspace')).toBeNull()
    fireEvent.click(screen.getByLabelText('Remember in this browser'))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(JSON.parse(localStorage.getItem('mapper.workspace')!).format).toBe('mapper-project')
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved work' }))
    expect(localStorage.getItem('mapper.workspace')).toBeNull()
    vi.useRealTimers()
  })
})
