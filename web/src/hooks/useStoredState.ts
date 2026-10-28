import { useEffect, useState } from 'react'

/** useState that remembers its value in localStorage (per browser). Falls back silently if storage is unavailable. */
export function useStoredState<T>(key: string, initial: () => T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored !== null) return JSON.parse(stored) as T
    } catch {
      // Unavailable or corrupted storage: use the initial value
    }
    return initial()
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Not critical: the value just won't be remembered
    }
  }, [key, value])

  return [value, setValue] as const
}
