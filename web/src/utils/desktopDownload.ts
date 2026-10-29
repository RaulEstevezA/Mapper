// Release assets keep the same names in every version (see .github/workflows/release-desktop.yml),
// so these links always point to the latest release.
export const RELEASES_URL = 'https://github.com/RaulEstevezA/Mapper/releases/latest'

export type DesktopPlatform = 'macOS' | 'Windows' | 'Linux'
export type Architecture = 'x64' | 'arm64'

const ASSETS: Record<DesktopPlatform, Partial<Record<Architecture, string>>> = {
  // Apple Silicon only
  macOS: { arm64: 'Mapper-macOS.dmg' },
  Windows: { x64: 'Mapper-Windows.zip', arm64: 'Mapper-Windows-ARM64.zip' },
  Linux: { x64: 'Mapper-Linux.tar.gz', arm64: 'Mapper-Linux-ARM64.tar.gz' },
}

/** Whether the platform has one build per architecture, so the visitor may need to pick one. */
export function hasArchitectureChoice(platform: DesktopPlatform): boolean {
  return Object.keys(ASSETS[platform]).length > 1
}

export function downloadUrl(platform: DesktopPlatform, architecture: Architecture = 'x64'): string {
  const assets = ASSETS[platform]
  return `${RELEASES_URL}/download/${assets[architecture] ?? Object.values(assets)[0]}`
}

interface NavigatorInfo {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  // User-Agent Client Hints: only in Chromium browsers (Chrome, Edge...)
  userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> }
}

/** The visitor's desktop system, or null on phones, tablets and anything unknown. Only reads
 * the browser's own information: nothing is requested from GitHub until the button is clicked. */
export function detectPlatform({ userAgent, platform = '', maxTouchPoints = 0 }: NavigatorInfo): DesktopPlatform | null {
  const text = `${platform} ${userAgent}`
  if (/android|iphone|ipad|ipod|mobile/i.test(text)) return null
  // iPadOS presents itself as a Mac; a touch screen gives it away
  if (/mac/i.test(text)) return maxTouchPoints > 1 ? null : 'macOS'
  if (/win/i.test(text)) return 'Windows'
  if (/linux|x11/i.test(text) && !/cros/i.test(text)) return 'Linux'
  return null
}

/** The processor architecture, or null when the browser doesn't tell. Windows browsers always
 * claim x64 in the user agent, so only Client Hints can tell an ARM laptop; Firefox on Linux
 * names it in the user agent. Safari and Firefox on Windows don't give it at all. */
export async function detectArchitecture({ userAgent, platform = '', userAgentData }: NavigatorInfo): Promise<Architecture | null> {
  if (/aarch64|arm64/i.test(`${platform} ${userAgent}`)) return 'arm64'
  try {
    const { architecture } = (await userAgentData?.getHighEntropyValues(['architecture'])) ?? {}
    if (architecture === 'arm') return 'arm64'
    if (architecture === 'x86') return 'x64'
  } catch {
    // The browser refused the hint: same as not knowing
  }
  return null
}
