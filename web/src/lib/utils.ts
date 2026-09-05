export { cn } from "cn"

/** Compact byte formatting shared by the traffic columns and KPI cards. */
export function formatBytes(bytes?: number): string {
  const value = bytes || 0
  if (value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const scaled = value / Math.pow(1024, i)
  return `${scaled.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
