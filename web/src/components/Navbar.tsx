import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ServerIcon,
  RefreshIcon,
  LogoutIcon,
  SunIcon,
  MoonIcon,
} from "@/components/icons"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface NavbarProps {
  instanceId?: string
  isOnline: boolean
  isRefreshing: boolean
  autoRefreshInterval: number
  onIntervalChange: (interval: number) => void
  onManualRefresh: () => void
  onLogout: () => void
}

const REFRESH_OPTIONS = [0, 3000, 5000, 10000, 30000, 60000]

/** The trigger renders the raw value unless we map it back to a label. */
function refreshLabel(ms: number): string {
  if (!ms) return "Auto: Off"
  return ms >= 60000 ? `Auto: ${ms / 60000}m` : `Auto: ${ms / 1000}s`
}

export function Navbar({
  instanceId,
  isOnline,
  isRefreshing,
  autoRefreshInterval,
  onIntervalChange,
  onManualRefresh,
  onLogout,
}: NavbarProps) {
  const { theme, setTheme } = useTheme()

  const toggleTheme = () => {
    if (theme === "dark") {
      setTheme("light")
    } else {
      setTheme("dark")
    }
  }

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border/70 bg-background/80 backdrop-blur-md px-4 lg:px-8 py-2.5">
      <div className="flex items-center justify-between gap-4 max-w-7xl mx-auto">
        {/* Left: Brand & Status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-xs">
              <ServerIcon size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-heading font-bold text-base tracking-wider">HLT</span>
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-widest hidden sm:inline">
                  Tunnel Console
                </span>
                <Badge
                  variant={isOnline ? "success" : "destructive"}
                  className="text-[10px] py-0 px-1.5 h-4 font-mono uppercase"
                >
                  <span
                    className={`size-1.5 rounded-full mr-1 ${
                      isOnline ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                    }`}
                  />
                  {isOnline ? "Online" : "Offline"}
                </Badge>
              </div>
              {instanceId && (
                <div className="text-[10px] font-mono text-muted-foreground truncate max-w-[200px] sm:max-w-xs">
                  Node: {instanceId}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: Controls & Actions */}
        <div className="flex items-center gap-2">
          {/* Refresh controls */}
          <div className="flex items-center gap-1.5 bg-muted/60 p-1 rounded-lg border border-border/50 text-xs">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onManualRefresh}
              disabled={isRefreshing}
              title="Refresh now"
              className="size-6 text-muted-foreground hover:text-foreground"
            >
              <RefreshIcon
                size={13}
                className={isRefreshing ? "animate-spin text-primary" : ""}
              />
            </Button>
            <Select
              value={String(autoRefreshInterval)}
              onValueChange={(val: string | null) => val !== null && val !== undefined && onIntervalChange(Number(val))}
            >
              <SelectTrigger className="h-6 w-24 border-0 bg-transparent px-1.5 text-[11px] font-mono shadow-none focus:ring-0">
                <SelectValue>
                  {(value: unknown) => refreshLabel(Number(value ?? autoRefreshInterval))}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                {REFRESH_OPTIONS.map((ms) => (
                  <SelectItem key={ms} value={String(ms)}>
                    {refreshLabel(ms)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Theme toggle */}
          <Button
            variant="outline"
            size="icon-sm"
            onClick={toggleTheme}
            title="Toggle theme (press 'd')"
            className="size-8"
          >
            {theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
          </Button>

          {/* Logout button */}
          <Button
            variant="outline"
            size="sm"
            onClick={onLogout}
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40"
          >
            <LogoutIcon size={13} />
            <span className="hidden sm:inline">Sign Out</span>
          </Button>
        </div>
      </div>
    </header>
  )
}
