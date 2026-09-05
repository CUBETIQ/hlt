import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type {
  StatusResponse,
  SocketsResponse,
  ClientsResponse,
  TelemetryStats,
  GenerateTokenResponse,
} from "@/lib/api"

export const QUERY_KEYS = {
  status: ["serverStatus"] as const,
  sockets: ["sockets"] as const,
  clients: ["clients"] as const,
  stats: ["stats"] as const,
}

export function useServerStatus(refetchInterval: number | false) {
  return useQuery<StatusResponse>({
    queryKey: QUERY_KEYS.status,
    queryFn: api.getStatus,
    refetchInterval: refetchInterval || false,
    staleTime: 2000,
    retry: 1,
  })
}

export function useSockets(refetchInterval: number | false) {
  return useQuery<SocketsResponse>({
    queryKey: QUERY_KEYS.sockets,
    queryFn: api.getSockets,
    refetchInterval: refetchInterval || false,
    staleTime: 2000,
    retry: 1,
  })
}

export function useClients(refetchInterval: number | false) {
  return useQuery<ClientsResponse>({
    queryKey: QUERY_KEYS.clients,
    queryFn: api.getClients,
    refetchInterval: refetchInterval || false,
    staleTime: 2000,
    retry: 1,
  })
}

export function useStats(refetchInterval: number | false) {
  return useQuery<TelemetryStats>({
    queryKey: QUERY_KEYS.stats,
    queryFn: api.getStats,
    refetchInterval: refetchInterval || false,
    staleTime: 2000,
    retry: 1,
  })
}

export function useDisconnectSocket() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (host: string) => api.disconnectSocket(host),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sockets })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.clients })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.status })
    },
  })
}

export function useDisconnectClient() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (clientId: string) => api.disconnectClient(clientId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.clients })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sockets })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.status })
    },
  })
}

export function useGenerateToken() {
  return useMutation<
    GenerateTokenResponse,
    Error,
    { clientId?: string; expiresIn?: string }
  >({
    mutationFn: ({ clientId, expiresIn }) => api.generateToken(clientId, expiresIn),
  })
}
