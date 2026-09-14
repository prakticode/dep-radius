import { getISOWeek, getISOWeekYear } from "date-fns"

export function weekKey(date: Date): string {
  const week = getISOWeek(date)
  return `${getISOWeekYear(date)}-W${String(week).padStart(2, "0")}`
}
