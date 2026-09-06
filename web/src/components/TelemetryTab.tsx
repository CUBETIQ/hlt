import { useMemo } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import type { TelemetryStats } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/ui/data-table"
import { formatBytes, formatCompact } from "@/lib/utils"
import {
  ShieldIcon,
  ActivityIcon,
  DatabaseIcon,
  ClockIcon,
} from "@/components/icons"

interface TelemetryTabProps {
  stats: TelemetryStats | null
}

interface HostStatRow {
  host: string
  requests: number
  http: number
  ws: number
  bytesIn: number
  bytesOut: number
}

export function TelemetryTab({ stats }: TelemetryTabProps) {
  const rawHostStats = stats?.hostStats
  const storage = (stats?.storage as string) || "memory"
  const totalRequests =
    stats?.totalRequests ??
    (stats as Record<string, unknown> | undefined)?.total_http_requests as number ??
    0
  const totalConnections =
    stats?.totalConnections ??
    (stats as Record<string, unknown> | undefined)?.total_connections as number ??
    0

  const tableData = useMemo<HostStatRow[]>(() => {
    return Object.entries(rawHostStats || {}).map(([host, data]) => {
      const http = data?.http_count || 0
      const ws = data?.ws_count || 0
      return {
        host,
        requests: data?.requests ?? http + ws,
        http,
        ws,
        bytesIn: data?.bytes_in || 0,
        bytesOut: data?.bytes_out || 0,
      }
    })
  }, [rawHostStats])

  const columns = useMemo<ColumnDef<HostStatRow>[]>(
    () => [
      {
        accessorKey: "host",
        header: "Host",
        cell: ({ row }) => (
          <span className="font-mono text-xs font-semibold">{row.original.host}</span>
        ),
      },
      {
        accessorKey: "requests",
        header: () => <div className="text-right">Requests</div>,
        cell: ({ row }) => (
          <div className="text-right" title={`${row.original.requests.toLocaleString()} requests`}>
            <div className="font-mono text-xs font-medium">
              {formatCompact(row.original.requests)}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {formatCompact(row.original.http)} http &bull;{" "}
              {formatCompact(row.original.ws)} ws
            </div>
          </div>
        ),
      },
      {
        id: "inbound",
        header: () => <div className="text-right">Inbound</div>,
        cell: ({ row }) => (
          <div className="text-right font-mono text-xs text-sky-600 dark:text-sky-400">
            &darr; {formatBytes(row.original.bytesIn)}
          </div>
        ),
      },
      {
        id: "outbound",
        header: () => <div className="text-right">Outbound</div>,
        cell: ({ row }) => (
          <div className="text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
            &uarr; {formatBytes(row.original.bytesOut)}
          </div>
        ),
      },
    ],
    []
  )

  return (
    <div className="space-y-4">
      {/* Privacy Notice Banner */}
      <div className="flex items-center gap-2 p-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-xs text-muted-foreground">
        <ShieldIcon size={14} className="text-emerald-500 shrink-0" />
        <span>
          <strong className="text-foreground font-medium">Zero-PII Telemetry:</strong> Only aggregate numerical counters are recorded. No headers, payload data, or tokens are retained.
        </span>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-border/60">
          <CardContent className="p-3.5 flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-[11px] text-muted-foreground font-medium uppercase">Requests</span>
              <div className="font-heading font-bold text-xl sm:text-2xl text-foreground">
                {formatCompact(totalRequests)}
              </div>
            </div>
            <div className="size-8 rounded bg-blue-500/10 text-blue-500 flex items-center justify-center border border-blue-500/20 shrink-0">
              <ActivityIcon size={15} />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60">
          <CardContent className="p-3.5 flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-[11px] text-muted-foreground font-medium uppercase">Sessions</span>
              <div className="font-heading font-bold text-xl sm:text-2xl text-foreground">
                {formatCompact(totalConnections)}
              </div>
            </div>
            <div className="size-8 rounded bg-purple-500/10 text-purple-500 flex items-center justify-center border border-purple-500/20 shrink-0">
              <ClockIcon size={15} />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60">
          <CardContent className="p-3.5 flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-[11px] text-muted-foreground font-medium uppercase">Hosts</span>
              <div className="font-heading font-bold text-xl sm:text-2xl text-foreground">
                {tableData.length}
              </div>
            </div>
            <div className="size-8 rounded bg-emerald-500/10 text-emerald-500 flex items-center justify-center border border-emerald-500/20 shrink-0">
              <DatabaseIcon size={15} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Host Traffic Table */}
      <Card className="border-border/60">
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <DatabaseIcon size={16} className="text-primary" />
            Host Traffic
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge
              variant={storage === "redis" ? "success" : "outline"}
              className="font-mono text-[10px] py-0"
              title={
                storage === "redis"
                  ? "Counters are shared across all workers via Redis"
                  : "Counters live in this process/cluster only"
              }
            >
              {storage}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px] py-0">
              {tableData.length} records
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="pt-1">
          <DataTable
            columns={columns}
            data={tableData}
            emptyMessage="No host traffic records yet."
          />
        </CardContent>
      </Card>
    </div>
  )
}
