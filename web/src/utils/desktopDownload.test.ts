import { describe, expect, it } from 'vitest'
import { detectArchitecture, detectPlatform, downloadUrl, hasArchitectureChoice } from './desktopDownload.ts'

describe('detectPlatform', () => {
  it.each([
    [{ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, 'macOS'],
    [{ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'Windows'],
    [{ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, 'Linux'],
  ])('detects desktop systems: %o', (navigator, expected) => {
    expect(detectPlatform(navigator)).toBe(expected)
  })

  it.each([
    { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile' },
    { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 },
    { platform: '', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)' },
    { platform: '', userAgent: '' },
  ])('returns null for phones, tablets and unknown systems: %o', (navigator) => {
    expect(detectPlatform(navigator)).toBeNull()
  })
})

describe('detectArchitecture', () => {
  const hints = (architecture: string) => ({ getHighEntropyValues: async () => ({ architecture }) })

  it('reads ARM64 from the user agent', async () => {
    expect(await detectArchitecture({ platform: 'Linux aarch64', userAgent: 'Mozilla/5.0 (X11; Linux aarch64; rv:140.0)' })).toBe('arm64')
  })

  it('reads the architecture from Client Hints', async () => {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    expect(await detectArchitecture({ platform: 'Win32', userAgent, userAgentData: hints('arm') })).toBe('arm64')
    expect(await detectArchitecture({ platform: 'Win32', userAgent, userAgentData: hints('x86') })).toBe('x64')
  })

  it('returns null when the browser does not tell', async () => {
    // Windows on ARM also claims x64 in the user agent
    expect(await detectArchitecture({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBeNull()
    const refused = { getHighEntropyValues: () => Promise.reject(new Error('NotAllowedError')) }
    expect(await detectArchitecture({ userAgent: '', userAgentData: refused })).toBeNull()
  })
})

describe('downloadUrl', () => {
  const latest = 'https://github.com/RaulEstevezA/Mapper/releases/latest/download/'

  it('points to the asset of the latest release', () => {
    expect(downloadUrl('Windows')).toBe(`${latest}Mapper-Windows.zip`)
    expect(downloadUrl('Windows', 'arm64')).toBe(`${latest}Mapper-Windows-ARM64.zip`)
    expect(downloadUrl('Linux', 'arm64')).toBe(`${latest}Mapper-Linux-ARM64.tar.gz`)
  })

  it('uses the only macOS build for any architecture', () => {
    expect(downloadUrl('macOS')).toBe(`${latest}Mapper-macOS.dmg`)
    expect(hasArchitectureChoice('macOS')).toBe(false)
    expect(hasArchitectureChoice('Windows')).toBe(true)
  })
})
