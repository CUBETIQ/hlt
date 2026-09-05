import type { StatusResponse, TelemetryStats } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ActivityIcon,
  RadioIcon,
  ClockIcon,
  CpuIcon,
  HardDriveIcon,
  ServerIcon,
} from "@/components/icons"

interface OverviewTabProps {
  status: StatusResponse | null
  stats: TelemetryStats | null
}

function formatUptime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "0s"
  const d = Math.floor(seconds / (3600 * 24))
  const h = Math.floor((seconds % (3600 * 24)) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0 || d > 0) parts.push(`${h}h`)
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(" ")
}

function formatBytes(bytes: number): string {
  if (!bytes || isNaN(bytes)) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(1)} ${units[i]}`
}

export function OverviewTab({ status, stats }: OverviewTabProps) {
  const activeSockets =
    status?.activeSocketsCount ??
    (status?.stats as Record<string, unknown> | undefined)?.active_sockets as number ??
    (stats as Record<string, unknown> | undefined)?.active_sockets as number ??
    0

  const uptime = status?.uptime ?? (stats?.service?.uptime ?? 0)

  const totalRequests =
    stats?.totalRequests ??
    (stats as Record<string, unknown> | undefined)?.total_http_requests as number ??
    (status?.stats as Record<string, unknown> | undefined)?.totalRequests as number ??
    (status?.stats as Record<string, unknown> | undefined)?.total_http_requests as number ??
    0

  const totalConnections =
    stats?.totalConnections ??
    (stats as Record<string, unknown> | undefined)?.total_connections as number ??
    (status?.stats as Record<string, unknown> | undefined)?.totalConnections as number ??
    (status?.stats as Record<string, unknown> | undefined)?.total_connections as number ??
    0

  const mem = status?.memoryUsage
  const heapUsed = mem?.heapUsed ?? 0
  const heapTotal = mem?.heapTotal ?? 1
  const heapPercent = Math.min(Math.round((heapUsed / heapTotal) * 100), 100)
  const rss = mem?.rss ?? 0

  const cpu = status?.cpuUsage
  const userCpuSec = ((cpu?.user ?? 0) / 1000000).toFixed(2)
  const systemCpuSec = ((cpu?.system ?? 0) / 1000000).toFixed(2)

  return (
    <div className="space-y-5">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* Active Tunnels */}
        <Card className="border-border/60 bg-card">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="space-y-1 min-w-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Active Tunnels
              </span>
              <div className="flex items-baseline gap-2">
                <span className="font-heading font-bold text-2xl sm:text-3xl tracking-tight text-foreground">
                  {activeSockets}
                </span>
                <Badge
                  variant={activeSockets > 0 ? "success" : "outline"}
                  className="text-[10px] py-0 px-1.5"
                >
                  {activeSockets > 0 ? "Live" : "Idle"}
                </Badge>
              </div>
            </div>
            <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center border border-primary/20 shrink-0">
              <RadioIcon size={18} />
            </div>
          </CardContent>
        </Card>

        {/* Requests */}
        <Card className="border-border/60 bg-card">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="space-y-1 min-w-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Requests
              </span>
              <div className="flex items-baseline gap-2">
                <span className="font-heading font-bold text-2xl sm:text-3xl tracking-tight text-foreground">
                  {totalRequests.toLocaleString()}
                </span>
                <span className="text-[11px] text-muted-foreground font-mono">routed</span>
              </div>
            </div>
            <div className="size-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center border border-blue-500/20 shrink-0">
              <ActivityIcon size={18} />
            </div>
          </CardContent>
        </Card>

        {/* Connections */}
        <Card className="border-border/60 bg-card">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="space-y-1 min-w-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Sessions
              </span>
              <div className="flex items-baseline gap-2">
                <span className="font-heading font-bold text-2xl sm:text-3xl tracking-tight text-foreground">
                  {totalConnections.toLocaleString()}
                </span>
                <span className="text-[11px] text-muted-foreground font-mono">total</span>
              </div>
            </div>
            <div className="size-10 rounded-lg bg-purple-500/10 text-purple-500 flex items-center justify-center border border-purple-500/20 shrink-0">
              <ServerIcon size={18} />
            </div>
          </CardContent>
        </Card>

        {/* Uptime */}
        <Card className="border-border/60 bg-card">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="space-y-1 min-w-0">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Uptime
              </span>
              <div className="font-heading font-bold text-xl sm:text-2xl tracking-tight text-foreground truncate">
                {formatUptime(uptime)}
              </div>
            </div>
            <div className="size-10 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center border border-amber-500/20 shrink-0">
              <ClockIcon size={18} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Resource Telemetry */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Memory */}
        <Card className="border-border/60">
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <HardDriveIcon size={16} className="text-primary" />
              Memory
            </CardTitle>
            <Badge variant="outline" className="font-mono text-[11px]">
              RSS {formatBytes(rss)}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
                <span>Heap: {formatBytes(heapUsed)} / {formatBytes(heapTotal)}</span>
                <span className="font-semibold text-foreground">{heapPercent}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 rounded-full ${
                    heapPercent > 80
                      ? "bg-rose-500"
                      : heapPercent > 60
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                  }`}
                  style={{ width: `${Math.max(heapPercent, 2)}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 pt-1 font-mono text-center">
              <div className="p-2 rounded bg-muted/40 border border-border/30">
                <div className="text-[10px] text-muted-foreground">RSS</div>
                <div className="font-semibold text-xs mt-0.5">{formatBytes(mem?.rss ?? 0)}</div>
              </div>
              <div className="p-2 rounded bg-muted/40 border border-border/30">
                <div className="text-[10px] text-muted-foreground">Heap Used</div>
                <div className="font-semibold text-xs mt-0.5">{formatBytes(mem?.heapUsed ?? 0)}</div>
              </div>
              <div className="p-2 rounded bg-muted/40 border border-border/30">
                <div className="text-[10px] text-muted-foreground">Heap Total</div>
                <div className="font-semibold text-xs mt-0.5">{formatBytes(mem?.heapTotal ?? 0)}</div>
              </div>
              <div className="p-2 rounded bg-muted/40 border border-border/30">
                <div className="text-[10px] text-muted-foreground">External</div>
                <div className="font-semibold text-xs mt-0.5">{formatBytes(mem?.external ?? 0)}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* CPU & Node */}
        <Card className="border-border/60">
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <CpuIcon size={16} className="text-primary" />
              CPU & System
            </CardTitle>
            <Badge variant="outline" className="font-mono text-[11px]">
              PID {status?.instance?.split("#")[1] || "—"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-2 font-mono">
              <div className="p-2.5 rounded bg-muted/40 border border-border/30">
                <div className="text-[10px] text-muted-foreground uppercase">User CPU</div>
                <div className="font-bold text-base text-foreground mt-0.5">{userCpuSec}s</div>
              </div>
              <div className="p-2.5 rounded bg-muted/40 border border-border/30">
                <div className="text-[10px] text-muted-foreground uppercase">System CPU</div>
                <div className="font-bold text-base text-foreground mt-0.5">{systemCpuSec}s</div>
              </div>
            </div>

            <div className="p-2.5 rounded bg-muted/30 border border-border/30 flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">Engine: v{status?.build?.version || "2.0.0"}</span>
              <span className="text-muted-foreground truncate max-w-[200px]">{status?.instance || "Local"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
