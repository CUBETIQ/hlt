import { useMemo } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import type { TelemetryStats } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/ui/data-table"
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
}

export function TelemetryTab({ stats }: TelemetryTabProps) {
  const hostStats = (stats?.hostStats || {}) as Record<string, Record<string, unknown>>
  const totalRequests =
    stats?.totalRequests ??
    (stats as Record<string, unknown> | undefined)?.total_http_requests as number ??
    0
  const totalConnections =
    stats?.totalConnections ??
    (stats as Record<string, unknown> | undefined)?.total_connections as number ??
    0

  const tableData = useMemo<HostStatRow[]>(() => {
    return Object.entries(hostStats).map(([host, data]) => ({
      host,
      requests: (data?.requests as number) || (data?.http_count as number) || 0,
    }))
  }, [hostStats])

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
          <div className="text-right font-mono text-xs font-medium">
            {row.original.requests.toLocaleString()}
          </div>
        ),
      },
      {
        id: "status",
        header: () => <div className="text-right">Tracking</div>,
        cell: () => (
          <div className="text-right">
            <Badge variant="outline" className="text-[10px] py-0 px-1 font-mono">
              active
            </Badge>
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
                {totalRequests.toLocaleString()}
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
                {totalConnections.toLocaleString()}
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
          <Badge variant="outline" className="font-mono text-[10px] py-0">
            {tableData.length} records
          </Badge>
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
