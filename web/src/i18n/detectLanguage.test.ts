import { describe, expect, it } from 'vitest'
import { detectLanguage } from './detectLanguage.ts'

const blocked = () => {
  throw new Error('blocked')
}

describe('detectLanguage', () => {
  it('prefers the language inherited from the website over the browser', () => {
    expect(detectLanguage(() => 'es', 'en-US')).toBe('es')
    expect(detectLanguage(() => 'en', 'es-ES')).toBe('en')
  })

  it('uses the browser when nothing valid is inherited', () => {
    expect(detectLanguage(() => null, 'es-ES')).toBe('es')
    expect(detectLanguage(() => 'fr', 'es-ES')).toBe('es')
    expect(detectLanguage(blocked, 'es-ES')).toBe('es')
  })

  it('falls back to English', () => {
    expect(detectLanguage(() => null, 'fr-FR')).toBe('en')
    expect(detectLanguage(blocked, 'de')).toBe('en')
  })
})
