import { useState } from "react"
import { useGenerateToken } from "@/lib/queries"
import type { GenerateTokenResponse } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  KeyIcon,
  CopyIcon,
  CheckIcon,
  TerminalIcon,
  AlertCircleIcon,
  RefreshIcon,
} from "@/components/icons"

export function TokensTab() {
  const [clientId, setClientId] = useState("")
  const [expiresIn, setExpiresIn] = useState("30d")
  const [result, setResult] = useState<GenerateTokenResponse | null>(null)
  const [copiedToken, setCopiedToken] = useState(false)
  const [copiedCli, setCopiedCli] = useState(false)

  const generateMutation = useGenerateToken()

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCopiedToken(false)
    setCopiedCli(false)

    try {
      const res = await generateMutation.mutateAsync({
        clientId: clientId.trim() || undefined,
        expiresIn,
      })
      setResult(res)
    } catch {
      // handled by mutation error
    }
  }

  const handleRandomClientId = () => {
    const randomId = "client-" + Math.random().toString(36).substring(2, 9)
    setClientId(randomId)
  }

  const copyToClipboard = async (text: string, type: "token" | "cli") => {
    try {
      await navigator.clipboard.writeText(text)
      if (type === "token") {
        setCopiedToken(true)
        setTimeout(() => setCopiedToken(false), 1500)
      } else {
        setCopiedCli(true)
        setTimeout(() => setCopiedCli(false), 1500)
      }
    } catch {
      // fallback
    }
  }

  const serverUrl = window.location.origin
  const cliCommand = result
    ? `hlt start 8080 --server ${serverUrl} -t ${result.token}`
    : ""

  return (
    <div className="space-y-4 max-w-3xl">
      <Card className="border-border/60">
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <KeyIcon size={16} className="text-primary" />
            Token Generator
          </CardTitle>
          <span className="text-[11px] text-muted-foreground font-mono">JWT / HMAC-SHA256</span>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleGenerate} className="space-y-3.5">
            {generateMutation.error && (
              <div className="flex items-center gap-2 p-2.5 rounded bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                <AlertCircleIcon size={14} className="shrink-0" />
                <span>{generateMutation.error.message}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-medium text-muted-foreground" htmlFor="token-client-id">
                    Client ID (optional)
                  </label>
                  <button
                    type="button"
                    onClick={handleRandomClientId}
                    className="text-[10px] text-primary hover:underline font-mono"
                  >
                    Random
                  </button>
                </div>
                <Input
                  id="token-client-id"
                  placeholder="auto-generated UUID if blank"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="font-mono text-xs h-8"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground" htmlFor="token-expiry">
                  Expiry
                </label>
                <Select value={expiresIn} onValueChange={(val: string | null) => val && setExpiresIn(val)}>
                  <SelectTrigger className="w-full h-8 text-xs font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1d">1 day</SelectItem>
                    <SelectItem value="7d">7 days</SelectItem>
                    <SelectItem value="30d">30 days</SelectItem>
                    <SelectItem value="90d">90 days</SelectItem>
                    <SelectItem value="365d">1 year</SelectItem>
                    <SelectItem value="3650d">10 years</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button type="submit" disabled={generateMutation.isPending} className="h-8 text-xs font-medium gap-1.5">
              {generateMutation.isPending ? (
                <>
                  <RefreshIcon size={12} className="animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <KeyIcon size={12} />
                  Generate Token
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-border/80 bg-muted/20">
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <CheckIcon size={14} className="text-emerald-500" />
              Generated Token
            </span>
            <div className="flex items-center gap-1.5 font-mono text-[10px]">
              <Badge variant="outline">{result.clientId}</Badge>
              <Badge variant="success">{result.expiresIn}</Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-3 pt-1">
            <div className="relative">
              <div className="p-2.5 rounded bg-background border border-border/60 font-mono text-[11px] break-all select-all text-foreground pr-9">
                {result.token}
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => copyToClipboard(result.token, "token")}
                className="absolute right-1.5 top-1.5 size-6 text-muted-foreground hover:text-foreground"
                title="Copy Token"
              >
                {copiedToken ? <CheckIcon size={12} className="text-emerald-500" /> : <CopyIcon size={12} />}
              </Button>
            </div>

            <div className="relative">
              <div className="p-2 rounded bg-background border border-border/60 font-mono text-xs text-foreground overflow-x-auto whitespace-nowrap pr-9 flex items-center gap-1.5">
                <TerminalIcon size={12} className="text-primary shrink-0" />
                <code>{cliCommand}</code>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => copyToClipboard(cliCommand, "cli")}
                className="absolute right-1.5 top-1.5 size-6 text-muted-foreground hover:text-foreground"
                title="Copy CLI Command"
              >
                {copiedCli ? <CheckIcon size={12} className="text-emerald-500" /> : <CopyIcon size={12} />}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
