import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Whether a command is installed, to skip compiler checks on machines without it. */
export function hasCommand(command: string, args: string[] = ['--version']): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 20000 })
    return true
  } catch {
    return false
  }
}

/** Writes files to a temporary folder and runs a checker on them. Returns its error output, or '' when it passes. */
export function runChecker(files: Record<string, string>, command: string, args: (dir: string) => string[], timeout = 60000): string {
  const dir = mkdtempSync(join(tmpdir(), 'mapper-check-'))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    execFileSync(command, args(dir), { cwd: dir, stdio: 'pipe', timeout })
    return ''
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer; message: string }
    return `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}` || failure.message
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
