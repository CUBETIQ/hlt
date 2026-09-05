import { useState, useMemo } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import type { ClientItem } from "@/lib/api"
import { useDisconnectClient } from "@/lib/queries"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/ui/data-table"
import {
  UsersIcon,
  SearchIcon,
  TrashIcon,
  AlertCircleIcon,
  RefreshIcon,
  ExternalLinkIcon,
  TerminalIcon,
} from "@/components/icons"

interface ClientsTabProps {
  clients: ClientItem[]
  loading: boolean
  onRefresh: () => void
}

function formatTimeAgo(timestamp?: number): string {
  if (!timestamp) return "-"
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ClientsTab({ clients, loading, onRefresh }: ClientsTabProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [confirmClientId, setConfirmClientId] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const disconnectMutation = useDisconnectClient()

  const handleDisconnect = async (clientId: string) => {
    setActionSuccess(null)
    try {
      await disconnectMutation.mutateAsync(clientId)
      setActionSuccess(`Disconnected client ${clientId}`)
      setConfirmClientId(null)
    } catch {
      // handled by mutation error
    }
  }

  const columns = useMemo<ColumnDef<ClientItem>[]>(
    () => [
      {
        accessorKey: "clientId",
        header: "Client ID",
        cell: ({ row }) => {
          const clientId = row.original.clientId
          const isOnline = row.original.status === "online" || row.original.activeTunnelsCount > 0
          return (
            <div className="flex items-center gap-2">
              <span
                className={`size-2 rounded-full shrink-0 ${
                  isOnline ? "bg-emerald-500 animate-pulse" : "bg-zinc-500"
                }`}
                title={isOnline ? "Online" : "Offline"}
              />
              <span className="font-mono text-xs font-semibold truncate max-w-[200px]" title={clientId}>
                {clientId}
              </span>
            </div>
          )
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const isOnline = row.original.status === "online" || row.original.activeTunnelsCount > 0
          return (
            <Badge
              variant={isOnline ? "success" : "secondary"}
              className="text-[10px] py-0 px-1.5 font-mono"
            >
              {isOnline ? "Online" : "Offline"}
            </Badge>
          )
        },
      },
      {
        id: "activeTunnels",
        header: "Active Tunnels",
        cell: ({ row }) => {
          const count = row.original.activeTunnelsCount || 0
          const hosts = row.original.activeHosts || []

          return (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Badge
                  variant={count > 0 ? "outline" : "secondary"}
                  className="font-mono text-[10px] px-1.5 py-0"
                >
                  {count} {count === 1 ? "tunnel" : "tunnels"}
                </Badge>
              </div>
              {hosts.length > 0 && (
                <div className="flex flex-wrap gap-1 max-w-xs">
                  {hosts.slice(0, 2).map((host) => (
                    <a
                      key={host}
                      href={`http://${host}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[10px] bg-muted/80 hover:bg-muted px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                      title={`Open http://${host}`}
                    >
                      <span className="truncate max-w-[120px]">{host}</span>
                      <ExternalLinkIcon size={9} />
                    </a>
                  ))}
                  {hosts.length > 2 && (
                    <span className="text-[10px] font-mono text-muted-foreground self-center">
                      +{hosts.length - 2} more
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        },
      },
      {
        accessorKey: "totalTunnelsCreated",
        header: () => <div className="text-right">Created Tunnels</div>,
        cell: ({ row }) => (
          <div className="text-right font-mono text-xs text-muted-foreground">
            {row.original.totalTunnelsCreated ?? 0}
          </div>
        ),
      },
      {
        accessorKey: "totalRequests",
        header: () => <div className="text-right">Total Requests</div>,
        cell: ({ row }) => (
          <div className="text-right font-mono text-xs font-medium">
            {(row.original.totalRequests || 0).toLocaleString()}
          </div>
        ),
      },
      {
        accessorKey: "lastSeen",
        header: () => <div className="text-right">Last Active</div>,
        cell: ({ row }) => (
          <div className="text-right font-mono text-[11px] text-muted-foreground">
            {formatTimeAgo(row.original.lastSeen)}
          </div>
        ),
      },
      {
        id: "actions",
        header: () => <div className="text-right">Action</div>,
        cell: ({ row }) => {
          const clientId = row.original.clientId
          const isActive = row.original.activeTunnelsCount > 0
          const isConfirming = confirmClientId === clientId
          const isBusy =
            disconnectMutation.isPending && disconnectMutation.variables === clientId

          if (!isActive) {
            return <div className="text-right text-[11px] text-muted-foreground">-</div>
          }

          return (
            <div className="text-right">
              {isConfirming ? (
                <div className="inline-flex items-center gap-1">
                  <Button
                    variant="destructive"
                    size="xs"
                    onClick={() => handleDisconnect(clientId)}
                    disabled={isBusy}
                    className="h-6 text-[11px] px-2"
                  >
                    {isBusy ? "Disconnecting..." : "Confirm"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setConfirmClientId(null)}
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
                  onClick={() => setConfirmClientId(clientId)}
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
    [confirmClientId, disconnectMutation.isPending, disconnectMutation.variables]
  )

  const activeCount = useMemo(
    () => clients.filter((c) => c.status === "online" || c.activeTunnelsCount > 0).length,
    [clients]
  )

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0 gap-3">
          <div className="flex items-center gap-2">
            <UsersIcon size={16} className="text-primary" />
            <CardTitle className="text-sm font-semibold">Clients</CardTitle>
            <Badge variant="outline" className="font-mono text-[10px] py-0">
              {clients.length} total &bull; {activeCount} active
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-44 sm:w-60">
              <Input
                placeholder="Filter clients..."
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
              title="Refresh client list"
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
            data={clients}
            globalFilter={searchQuery}
            onGlobalFilterChange={setSearchQuery}
            emptyMessage={
              <div className="p-6 text-center space-y-2">
                <div className="text-xs text-muted-foreground">No connected clients registered.</div>
                <div className="inline-flex items-center gap-1.5 p-2 rounded bg-muted/60 border border-border/40 font-mono text-xs text-muted-foreground">
                  <TerminalIcon size={12} className="text-primary" />
                  <code>hlt start 3000 --client my-client</code>
                </div>
              </div>
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}
