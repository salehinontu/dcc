const KEY = 'drone-fleet.alert-sound'

let context: AudioContext | null = null

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // the choice just is not remembered
  }
}

/**
 * A short two-tone beep: higher and doubled for a critical alert. Browsers only allow sound
 * after the page has had a click or key press, so a refused beep is simply skipped.
 */
export function beep(critical: boolean): void {
  if (!soundEnabled()) return
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const ctx = context
    const notes = critical ? [880, 660, 880, 660] : [660, 520]
    notes.forEach((frequency, index) => {
      const start = ctx.currentTime + index * 0.2
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17)
      oscillator.connect(gain).connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.18)
    })
  } catch {
    // no audio available
  }
}
