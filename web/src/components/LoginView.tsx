import { useState, type FormEvent } from "react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ShieldIcon, LockIcon, ServerIcon, AlertCircleIcon } from "@/components/icons"

interface LoginViewProps {
  onLoginSuccess: () => void
}

export function LoginView({ onLoginSuccess }: LoginViewProps) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) {
      setError("Username and password are required.")
      return
    }

    setLoading(true)
    setError(null)

    try {
      await api.login(username.trim(), password)
      onLoginSuccess()
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message)
      } else {
        setError("Failed to sign in. Check credentials and server status.")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-4 bg-radial from-muted/40 via-background to-background">
      <div className="w-full max-w-md animate-in fade-in zoom-in-95 duration-300">
        <div className="flex flex-col items-center mb-6 text-center">
          <div className="relative flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20 shadow-lg shadow-primary/5 mb-3">
            <ServerIcon size={28} />
            <div className="absolute -bottom-1 -right-1 size-4 rounded-full bg-emerald-500 border-2 border-background flex items-center justify-center">
              <div className="size-1.5 rounded-full bg-white animate-pulse" />
            </div>
          </div>
          <h1 className="font-heading font-bold text-2xl tracking-wider uppercase">HLT Console</h1>
          <p className="text-muted-foreground text-xs mt-0.5">Tunnel Server Administration</p>
        </div>

        <Card className="border-border/60 bg-card/80 backdrop-blur-md shadow-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldIcon size={16} className="text-primary" />
              Sign In
            </CardTitle>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {error && (
                <div className="flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                  <AlertCircleIcon size={16} className="shrink-0 mt-0.5" />
                  <span className="leading-tight">{error}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80" htmlFor="username">
                  Username
                </label>
                <Input
                  id="username"
                  placeholder="admin"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={loading}
                  autoComplete="username"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80" htmlFor="password">
                  Password
                </label>
                <div className="relative">
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    autoComplete="current-password"
                  />
                  <div className="absolute right-3 top-2.5 text-muted-foreground pointer-events-none">
                    <LockIcon size={14} />
                  </div>
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex flex-col gap-3 pt-2">
              <Button type="submit" className="w-full h-9 gap-2 font-medium text-xs" disabled={loading}>
                {loading ? (
                  <>
                    <div className="size-3.5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <LockIcon size={13} />
                    <span>Sign In</span>
                  </>
                )}
              </Button>

              <div className="text-center text-[11px] text-muted-foreground/60 font-mono">
                JWT Authenticated
              </div>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  )
}
