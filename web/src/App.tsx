import { useState, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { getStoredToken, clearStoredAuth } from "@/lib/api"
import { useServerStatus, useSockets, useClients, useStats, QUERY_KEYS } from "@/lib/queries"
import { Navbar } from "@/components/Navbar"
import { LoginView } from "@/components/LoginView"
import { OverviewTab } from "@/components/OverviewTab"
import { TunnelsTab } from "@/components/TunnelsTab"
import { ClientsTab } from "@/components/ClientsTab"
import { TokensTab } from "@/components/TokensTab"
import { TelemetryTab } from "@/components/TelemetryTab"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  ActivityIcon,
  RadioIcon,
  UsersIcon,
  KeyIcon,
  DatabaseIcon,
} from "@/components/icons"

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => !!getStoredToken())
  const [currentTab, setCurrentTab] = useState<string>("overview")
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(5000)

  const queryClient = useQueryClient()

  // TanStack Queries enabled only when authenticated
  const statusQuery = useServerStatus(isAuthenticated ? autoRefreshInterval : false)
  const socketsQuery = useSockets(isAuthenticated ? autoRefreshInterval : false)
  const clientsQuery = useClients(isAuthenticated ? autoRefreshInterval : false)
  const statsQuery = useStats(isAuthenticated ? autoRefreshInterval : false)

  const status = statusQuery.data ?? null
  const sockets = socketsQuery.data?.sockets ?? []
  const clients = clientsQuery.data?.clients ?? []
  const stats = statsQuery.data ?? null

  const isOnline = !statusQuery.isError
  const isRefreshing =
    statusQuery.isFetching ||
    socketsQuery.isFetching ||
    clientsQuery.isFetching ||
    statsQuery.isFetching

  const handleManualRefresh = () => {
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.status })
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sockets })
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.clients })
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats })
  }

  // Listen for 401 unauthorized events
  useEffect(() => {
    const handleUnauthorized = () => {
      setIsAuthenticated(false)
      queryClient.clear()
    }

    window.addEventListener("hlt-auth-unauthorized", handleUnauthorized)
    return () => {
      window.removeEventListener("hlt-auth-unauthorized", handleUnauthorized)
    }
  }, [queryClient])

  const handleLogout = () => {
    clearStoredAuth()
    setIsAuthenticated(false)
    queryClient.clear()
  }

  if (!isAuthenticated) {
    return <LoginView onLoginSuccess={() => setIsAuthenticated(true)} />
  }

  return (
    <div className="min-h-svh flex flex-col bg-background text-foreground antialiased selection:bg-primary/20">
      <Navbar
        instanceId={status?.instance}
        isOnline={isOnline}
        isRefreshing={isRefreshing}
        autoRefreshInterval={autoRefreshInterval}
        onIntervalChange={setAutoRefreshInterval}
        onManualRefresh={handleManualRefresh}
        onLogout={handleLogout}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <Tabs value={currentTab} onValueChange={setCurrentTab} className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/50 pb-4">
            <TabsList className="bg-muted/70 p-1 rounded-xl">
              <TabsTrigger value="overview" className="gap-2 px-3 py-1.5 rounded-lg text-xs">
                <ActivityIcon size={14} />
                <span>Overview</span>
              </TabsTrigger>

              <TabsTrigger value="tunnels" className="gap-2 px-3 py-1.5 rounded-lg text-xs">
                <RadioIcon size={14} />
                <span>Tunnels</span>
                {sockets.length > 0 && (
                  <span className="ml-0.5 rounded-full bg-primary/20 px-1.5 py-0.2 text-[10px] font-mono text-primary font-semibold">
                    {sockets.length}
                  </span>
                )}
              </TabsTrigger>

              <TabsTrigger value="clients" className="gap-2 px-3 py-1.5 rounded-lg text-xs">
                <UsersIcon size={14} />
                <span>Clients</span>
                {clients.length > 0 && (
                  <span className="ml-0.5 rounded-full bg-primary/20 px-1.5 py-0.2 text-[10px] font-mono text-primary font-semibold">
                    {clients.length}
                  </span>
                )}
              </TabsTrigger>

              <TabsTrigger value="tokens" className="gap-2 px-3 py-1.5 rounded-lg text-xs">
                <KeyIcon size={14} />
                <span>Tokens</span>
              </TabsTrigger>

              <TabsTrigger value="telemetry" className="gap-2 px-3 py-1.5 rounded-lg text-xs">
                <DatabaseIcon size={14} />
                <span>Telemetry</span>
              </TabsTrigger>
            </TabsList>

            <div className="text-[11px] font-mono text-muted-foreground hidden sm:flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-emerald-500 inline-block" />
              <span>Cluster Engine</span>
            </div>
          </div>

          <TabsContent value="overview">
            <OverviewTab status={status} stats={stats} />
          </TabsContent>

          <TabsContent value="tunnels">
            <TunnelsTab
              sockets={sockets}
              loading={isRefreshing}
              onRefresh={handleManualRefresh}
            />
          </TabsContent>

          <TabsContent value="clients">
            <ClientsTab
              clients={clients}
              loading={isRefreshing}
              onRefresh={handleManualRefresh}
            />
          </TabsContent>

          <TabsContent value="tokens">
            <TokensTab />
          </TabsContent>

          <TabsContent value="telemetry">
            <TelemetryTab stats={stats} />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t border-border/40 py-4 px-6 text-center text-xs text-muted-foreground/60">
        HLT &bull; Privacy-first High Performance HTTP Tunnel Server & Console
      </footer>
    </div>
  )
}

export default App
