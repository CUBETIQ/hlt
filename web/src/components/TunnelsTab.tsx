import { useState, useMemo } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import type { SocketItem } from "@/lib/api"
import { useDisconnectSocket } from "@/lib/queries"
import { formatBytes } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/ui/data-table"
import {
  SearchIcon,
  ExternalLinkIcon,
  TrashIcon,
  RadioIcon,
  AlertCircleIcon,
  RefreshIcon,
  TerminalIcon,
} from "@/components/icons"

interface TunnelsTabProps {
  sockets: SocketItem[]
  loading: boolean
  onRefresh: () => void
}

export function TunnelsTab({ sockets, loading, onRefresh }: TunnelsTabProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [confirmHost, setConfirmHost] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const disconnectMutation = useDisconnectSocket()

  const handleDisconnect = async (host: string) => {
    setActionSuccess(null)
    try {
      await disconnectMutation.mutateAsync(host)
      setActionSuccess(`Disconnected ${host}`)
      setConfirmHost(null)
    } catch {
      // handled by mutation error
    }
  }

  const columns = useMemo<ColumnDef<SocketItem>[]>(
    () => [
      {
        accessorKey: "host",
        header: "Host",
        cell: ({ row }) => {
          const host = row.original.host
          const aliases = row.original.aliases || []
          return (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 font-mono text-xs">
                <span className="font-semibold">{host}</span>
                <a
                  href={`http://${host}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors inline-flex items-center"
                  title={`Open http://${host}`}
                >
                  <ExternalLinkIcon size={12} />
                </a>
              </div>
              {aliases.length > 0 && (
                <div
                  className="font-mono text-[10px] text-muted-foreground truncate max-w-[260px]"
                  title={aliases.join("\n")}
                >
                  also: {aliases.slice(0, 2).join(", ")}
                  {aliases.length > 2 ? ` +${aliases.length - 2}` : ""}
                </div>
              )}
            </div>
          )
        },
      },
      {
        accessorKey: "clientId",
        header: "Client ID",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground truncate max-w-[180px] inline-block">
            {row.original.clientId || "anonymous"}
          </span>
        ),
      },
      {
        accessorKey: "connected",
        header: "Status",
        cell: ({ row }) => {
          const connected = row.original.connected
          return (
            <Badge
              variant={connected ? "success" : "destructive"}
              className="text-[10px] py-0 px-1.5"
            >
              <span
                className={`size-1.5 rounded-full mr-1 ${
                  connected ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                }`}
              />
              {connected ? "Active" : "Disconnected"}
            </Badge>
          )
        },
      },
      {
        id: "requests",
        header: () => <div className="text-right">Requests</div>,
        cell: ({ row }) => {
          const stats = row.original.stats
          const http = stats?.http_count || 0
          const ws = stats?.ws_count || 0
          const count = stats?.requests ?? http + ws
          return (
            <div className="text-right">
              <div className="font-mono text-xs font-medium">{count.toLocaleString()}</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                {http.toLocaleString()} http &bull; {ws.toLocaleString()} ws
              </div>
            </div>
          )
        },
      },
      {
        id: "traffic",
        header: () => <div className="text-right">Traffic</div>,
        cell: ({ row }) => (
          <div className="text-right font-mono text-[11px]">
            <div className="text-sky-600 dark:text-sky-400" title="Inbound (received from visitors)">
              &darr; {formatBytes(row.original.stats?.bytes_in)}
            </div>
            <div className="text-emerald-600 dark:text-emerald-400" title="Outbound (served to visitors)">
              &uarr; {formatBytes(row.original.stats?.bytes_out)}
            </div>
          </div>
        ),
      },
      {
        id: "actions",
        header: () => <div className="text-right">Action</div>,
        cell: ({ row }) => {
          const host = row.original.host
          const isConfirming = confirmHost === host
          const isBusy = disconnectMutation.isPending && disconnectMutation.variables === host

          return (
            <div className="text-right">
              {isConfirming ? (
                <div className="inline-flex items-center gap-1">
                  <Button
                    variant="destructive"
                    size="xs"
                    onClick={() => handleDisconnect(host)}
                    disabled={isBusy}
                    className="h-6 text-[11px] px-2"
                  >
                    {isBusy ? "Disconnecting..." : "Confirm"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setConfirmHost(null)}
                    disabled={isBusy}
                    className="h-6 text-[11px] px-2"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setConfirmHost(host)}
                  className="h-6 text-[11px] text-muted-foreground hover:text-destructive hover:border-destructive/40"
                >
                  <TrashIcon size={11} className="mr-1" />
                  Disconnect
                </Button>
              )}
            </div>
          )
        },
      },
    ],
    [confirmHost, disconnectMutation.isPending, disconnectMutation.variables]
  )

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0 gap-3">
          <div className="flex items-center gap-2">
            <RadioIcon size={16} className="text-primary" />
            <CardTitle className="text-sm font-semibold">Tunnels</CardTitle>
            <Badge variant="outline" className="font-mono text-[10px] py-0">
              {sockets.length}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-44 sm:w-60">
              <Input
                placeholder="Filter tunnels..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 pl-7 text-xs font-mono"
              />
              <div className="absolute left-2 top-2 text-muted-foreground pointer-events-none">
                <SearchIcon size={12} />
              </div>
            </div>

            <Button
              variant="outline"
              size="xs"
              onClick={onRefresh}
              disabled={loading}
              className="h-7 px-2 text-xs shrink-0"
              title="Refresh socket list"
            >
              <RefreshIcon size={12} className={loading ? "animate-spin" : ""} />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="pt-1">
          {disconnectMutation.error && (
            <div className="mb-3 flex items-center gap-2 p-2.5 rounded bg-destructive/10 border border-destructive/20 text-destructive text-xs">
              <AlertCircleIcon size={14} className="shrink-0" />
              <span>{disconnectMutation.error.message}</span>
            </div>
          )}

          {actionSuccess && (
            <div className="mb-3 flex items-center gap-2 p-2.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs">
              <span>{actionSuccess}</span>
            </div>
          )}

          <DataTable
            columns={columns}
            data={sockets}
            globalFilter={searchQuery}
            onGlobalFilterChange={setSearchQuery}
            emptyMessage={
              <div className="p-6 text-center space-y-2">
                <div className="text-xs text-muted-foreground">No active tunnels connected.</div>
                <div className="inline-flex items-center gap-1.5 p-2 rounded bg-muted/60 border border-border/40 font-mono text-xs text-muted-foreground">
                  <TerminalIcon size={12} className="text-primary" />
                  <code>hlt start 3000</code>
                </div>
              </div>
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}
