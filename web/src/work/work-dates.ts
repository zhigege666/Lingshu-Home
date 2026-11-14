export const workTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Civil dates are business labels, never inferred from an item's update time. */
export function workToday(timezone = workTimezone()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const value = (type: string) => parts.find(part => part.type === type)!.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function dueInputValue(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function dueInputISO(value: string): string {
  return value ? new Date(value).toISOString() : ''
}
