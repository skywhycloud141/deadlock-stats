const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000/deadlock').replace(/\/$/, '')

export interface Overview { accountId: number; totalMatches: number; winrate: string; averages: Record<string, number | null>; records: Record<string, number | null> }
export interface Fbi { trustScore: number; verdict: string; metrics: { feedPercentage: number | string; feedMatchesCount: number; abandonedCount: number; abandonPercentage: number | string; avgKdaRatio: number } }
export interface Coach { account_id: number; fromCache: boolean; coachReport: { playstyle: string; strengths: string[]; weaknesses: string[]; actionableTips: string[] } }
export interface HeroStats { heroId: number; matches: number; winrate?: string | number; avgKills?: number; avgDeaths?: number; avgAssists?: number; avgSouls?: number }
export interface Teammate { teammateId: number; sharedMatches: number; wins: number; winrate?: string | number; avgKda?: number; avgKills?: string | number; avgDeaths?: string | number; avgAssists?: string | number }
export interface PlayerMatch { matchId: number; heroId: number; kills: number; deaths: number; assists: number; isWinner: boolean; duration: number }
export interface MatchDetail { match_id: number; duration: number; winner_team: string; participants: Participant[] }
export interface Participant { account_id: number; hero_id: number; hero_lvl: number; team: string; kills: number; deaths: number; assists: number; net_worth: number; last_hits: number; denies: number; damage: number; abandoned: boolean; items: number[] }
export interface Page<T> { data: T[]; pagination: { page: number; limit: number; total: number; totalPages: number } }
export interface Job { jobId: string; status: string; failedReason?: string | null; attemptsMade?: number }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try { const body = await response.json(); message = body.error || message } catch { /* keep status message */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}
export const api = {
  overview: (id: string) => request<Overview>(`/players/${id}/overview`),
  fbi: (id: string) => request<Fbi>(`/players/${id}/fbi`),
  coach: (id: string) => request<Coach>(`/players/${id}/coach`),
  heroes: (id: string) => request<HeroStats[]>(`/players/${id}/heroes`),
  teammates: (id: string) => request<Teammate[]>(`/players/${id}/teammates`),
  matches: (id: string, page: number) => request<Page<PlayerMatch>>(`/players/${id}/matches?page=${page}&limit=10`),
  match: async (id: string) => { const payload = await request<{ match: { match_id: number; duration: number; winner_team: string }; participants: Participant[] }>(`/${id}`); return { ...payload.match, participants: payload.participants } },
  sync: (id: string) => request<{ jobId: string }>(`/sync/${id}`, { method: 'POST' }),
  syncBatch: (ids: number[]) => request<unknown>('/sync-batch', { method: 'POST', body: JSON.stringify({ matchIds: ids }) }),
  job: (id: string) => request<Job>(`/jobs/${id}`),
}
export const heroName = (id: number) => ({ 1: 'Infernus', 2: 'Seven', 3: 'Vindicta', 4: 'Lady Geist', 6: 'Abrams', 7: 'Wraith', 8: 'McGinnis', 10: 'Paradox', 11: 'Dynamo', 12: 'Kelvin', 13: 'Haze', 15: 'Bebop', 65: 'Calico', 76: 'Mirage' } as Record<number, string>)[id] || `Hero #${id}`
