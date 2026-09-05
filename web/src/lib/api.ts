export interface StatusResponse {
  instance: string
  uptime: number
  cpuUsage: {
    user: number
    system: number
  }
  memoryUsage: {
    rss: number
    heapTotal: number
    heapUsed: number
    external: number
    arrayBuffers?: number
  }
  build?: {
    version?: string
    commit?: string
    build_at?: string
  }
  stats?: TelemetryStats
  activeSocketsCount: number
}

export interface SocketItem {
  id: string
  host: string
  clientId: string | null
  aliases?: string[]
  connected: boolean
  stats?: {
    requests?: number
    http_count?: number
    ws_count?: number
    bytes_in?: number
    bytes_out?: number
    connected_at?: number
    last_active?: number
  }
}

export interface SocketsResponse {
  total: number
  sockets: SocketItem[]
}

export interface ClientItem {
  clientId: string
  activeTunnelsCount: number
  totalTunnelsCreated: number
  activeHosts: string[]
  totalRequests: number
  httpRequests?: number
  wsRequests?: number
  bytesIn?: number
  bytesOut?: number
  firstSeen: number
  lastSeen: number
  status: "online" | "offline"
}

export interface ClientsResponse {
  total: number
  clients: ClientItem[]
}

export interface TelemetryStats {
  totalRequests?: number
  totalConnections?: number
  totalHttpRequests?: number
  totalWsRequests?: number
  totalBytesIn?: number
  totalBytesOut?: number
  activeSockets?: number
  total_requests?: number
  total_connections?: number
  total_http_requests?: number
  total_ws_requests?: number
  total_bytes_in?: number
  total_bytes_out?: number
  active_sockets?: number
  service?: {
    name?: string
    instance?: string
    startedAt?: number
    uptime?: number
  }
  hostStats?: Record<
    string,
    {
      requests?: number
      http_count?: number
      ws_count?: number
      bytes_in?: number
      bytes_out?: number
      last_active?: number
    }
  >
  [key: string]: unknown
}

export interface GenerateTokenResponse {
  token: string
  clientId: string
  expiresIn: string
}

const TOKEN_KEY = "hlt_admin_token"
const USER_KEY = "hlt_admin_username"

export const getStoredToken = (): string | null => {
  return localStorage.getItem(TOKEN_KEY)
}

export const getStoredUsername = (): string | null => {
  return localStorage.getItem(USER_KEY)
}

export const setStoredAuth = (token: string, username: string) => {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, username)
}

export const clearStoredAuth = () => {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

const apiRequest = async <T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> => {
  const token = getStoredToken()
  const headers = new Headers(options.headers || {})
  headers.set("Content-Type", "application/json")

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  const res = await fetch(endpoint, {
    ...options,
    headers,
  })

  if (res.status === 401) {
    clearStoredAuth()
    window.dispatchEvent(new CustomEvent("hlt-auth-unauthorized"))
    throw new Error("Session expired or unauthorized. Please log in again.")
  }

  if (!res.ok) {
    let errorMsg = `HTTP Error ${res.status}`
    try {
      const data = await res.json()
      if (data && data.error) {
        errorMsg = data.error
      }
    } catch {
      // ignore json parse error
    }
    throw new Error(errorMsg)
  }

  return (await res.json()) as T
}

export const api = {
  login: async (username: string, password: string) => {
    const data = await apiRequest<{ token: string; expiresIn: string }>(
      "/admin/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }
    )
    setStoredAuth(data.token, username)
    return data
  },

  logout: () => {
    clearStoredAuth()
    window.dispatchEvent(new CustomEvent("hlt-auth-unauthorized"))
  },

  getStatus: () => apiRequest<StatusResponse>("/admin/api/status"),

  getSockets: () => apiRequest<SocketsResponse>("/admin/api/sockets"),

  disconnectSocket: (host: string) =>
    apiRequest<{ host: string; status: string }>(
      `/admin/api/sockets/${encodeURIComponent(host)}`,
      {
        method: "DELETE",
      }
    ),

  getStats: () => apiRequest<TelemetryStats>("/admin/api/stats"),

  getClients: () => apiRequest<ClientsResponse>("/admin/api/clients"),

  disconnectClient: (clientId: string) =>
    apiRequest<{ clientId: string; status: string; disconnectedCount: number }>(
      `/admin/api/clients/${encodeURIComponent(clientId)}`,
      {
        method: "DELETE",
      }
    ),

  generateToken: (clientId?: string, expiresIn?: string) =>
    apiRequest<GenerateTokenResponse>("/admin/api/tokens/generate", {
      method: "POST",
      body: JSON.stringify({ clientId: clientId || undefined, expiresIn }),
    }),
}
