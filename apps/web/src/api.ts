import type {
  Access,
  ActiveRecording,
  AlertRecord,
  ApiTokenCreated,
  ApiTokenRecord,
  DeviceSummary,
  FlightDetail,
  FlightSummary,
  PeopleCountResponse,
  PeopleMark,
  RecordingAutoDrone,
  RecordingFolder,
  RecordingRecord,
  RecordingTagCount,
  AuditFilter,
  AuditIntegrity,
  AuditPage,
  FolderListing,
  RecordingLocation,
  RecordingSort,
  RecordingStorage,
  ScreenshotRecord,
  StreamState,
  VideoSourceInfo,
  Zone,
  ZoneInput,
} from '@dji/protocol'
import { withBase } from './base'

export interface User extends Access {
  mustChangePassword: boolean
  /** Two-step sign-in is on for the account. */
  mfaEnabled?: boolean
  /** This role must have it on (set by the installation). */
  mfaRequired?: boolean
  /** It must, and has not set it up yet: the screen is held at the set-up until it has. */
  mfaEnrolRequired?: boolean
  disabled?: boolean
  id: string
  email: string
  role: string
  /** The Admin this account belongs to: itself for an Admin, null for a Developer or none. */
  adminId?: string | null
  createdBy?: string | null
  createdByEmail?: string | null
  /** When the account last signed in, from the audit trail; null if it never has. */
  lastLoginAt?: string | null
}

export interface TrailPoint {
  ts: string | null
  lat: number | null
  lon: number | null
  alt: number | null
}

export interface ControllerEnrolment {
  controllerSn: string
  status: 'pending' | 'approved' | 'rejected'
  ownerId: string | null
  workspaceId: string | null
  aircraftSns: string[]
  note: string | null
  requestedAt: string | null
  lastSeenAt: string | null
  approvedBy: string | null
  approvedAt: string | null
}

/** Every aircraft the system knows about, including the ones hidden from the fleet. */
export interface InventoryDevice {
  sn: string
  gatewaySn: string | null
  model: string | null
  displayName: string | null
  label: string | null
  online: boolean
  lastSeenAt: string | null
  disabledAt: string | null
  deletedAt: string | null
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBase(path), {
    credentials: 'include',
    ...init,
    headers: {
      // Only declare JSON when there is a body; Fastify rejects an empty JSON request.
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'))
    let message = text
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      /* plain text */
    }
    throw new Error(message || `request failed (${response.status})`)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export const api = {
  changeEmail: (currentPassword: string, email: string) =>
    request<{ ok: boolean; email: string }>('/api/auth/email', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, email }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  users: () => request<{ users: User[] }>('/api/users'),
  deleteUser: (id: string) =>
    request<void>(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createUser: (input: Access & { email: string; password: string; adminId?: string | null }) =>
    request('/api/users', { method: 'POST', body: JSON.stringify(input) }),
  updateUser: (id: string, input: Access & { disabled: boolean; password?: string }) =>
    request(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  apiTokens: () => request<{ tokens: ApiTokenRecord[] }>('/api/api-tokens'),
  createApiToken: (input: {
    name: string
    deviceSns: string[] | null
    expiresInDays: number | null
  }) =>
    request<ApiTokenCreated>('/api/api-tokens', { method: 'POST', body: JSON.stringify(input) }),
  revokeApiToken: (id: string) =>
    request<void>(`/api/api-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deleteDevice: (sn: string) =>
    request<void>(`/api/devices/${encodeURIComponent(sn)}`, { method: 'DELETE' }),
  reportNetwork: (
    id: string,
    input: {
      sessionId: string
      downlinkMbps?: number
      concurrentStreams: number
      loss: number
      stalled: boolean
    },
  ) => request<void>(`/api/streams/${id}/network`, { method: 'POST', body: JSON.stringify(input) }),
  me: () => request<{ user: User }>('/api/me'),
  /** A right password either signs in, or (two-step sign-in on) asks for a code: `mfaRequired` and a short-lived token. */
  login: (email: string, password: string) =>
    request<{ user: User } | { mfaRequired: true; mfaToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  /** The second step: the token from `login` and a six-digit code, or a recovery code. */
  mfaLogin: (mfaToken: string, code: string) =>
    request<{ user: User; method: 'totp' | 'recovery'; recoveryCodesLeft: number }>(
      '/api/auth/mfa',
      { method: 'POST', body: JSON.stringify({ token: mfaToken, code }) },
    ),
  mfaStatus: () =>
    request<{
      enabled: boolean
      required: boolean
      enabledAt: string | null
      recoveryCodesLeft: number
    }>('/api/auth/mfa'),
  /** Starts a set-up: the secret (to type), its address and a QR image (a data URL) to scan. */
  mfaSetup: (password: string) =>
    request<{ secret: string; otpauthUrl: string; qr: string }>('/api/auth/mfa/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  /** The first code the app shows turns it on and returns the recovery codes, which are shown only this once. */
  mfaEnable: (code: string) =>
    request<{ ok: boolean; recoveryCodes: string[] }>('/api/auth/mfa/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  mfaDisable: (password: string, code: string) =>
    request<{ ok: boolean }>('/api/auth/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    }),
  mfaRecoveryCodes: (password: string, code: string) =>
    request<{ ok: boolean; recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    }),
  /** An administrator resets an account whose phone was lost. */
  resetUserMfa: (id: string) =>
    request<{ user: User }>(`/api/users/${encodeURIComponent(id)}/mfa/reset`, { method: 'POST' }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  controllers: () => request<{ controllers: ControllerEnrolment[] }>('/api/admin/controllers'),
  approveController: (sn: string, aircraftSns?: string[]) =>
    request<{ ok: boolean }>(`/api/admin/controllers/${encodeURIComponent(sn)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ aircraftSns }),
    }),
  rejectController: (sn: string, reason?: string) =>
    request<{ ok: boolean }>(`/api/admin/controllers/${encodeURIComponent(sn)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unbindController: (sn: string) =>
    request<{ ok: boolean }>(`/api/admin/controllers/${encodeURIComponent(sn)}/unbind`, {
      method: 'POST',
    }),
  inventory: () => request<{ devices: InventoryDevice[] }>('/api/admin/devices'),
  setDeviceEnabled: (sn: string, enabled: boolean) =>
    request<{ ok: boolean; enabled: boolean }>(`/api/devices/${encodeURIComponent(sn)}/disable`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  devices: () => request<{ devices: DeviceSummary[] }>('/api/devices'),
  renameDevice: (sn: string, displayName: string | null) =>
    request<{ ok: boolean; displayName: string | null }>(`/api/devices/${encodeURIComponent(sn)}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }),
  /** Name, nickname and colour of an aircraft; send only what changes. */
  updateDevice: (
    sn: string,
    input: { displayName?: string | null; label?: string | null; color?: string },
  ) =>
    request<{ ok: boolean; displayName: string | null; label: string | null; color: string }>(
      `/api/devices/${encodeURIComponent(sn)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),
  /** Video-only drones: the address and key a pilot types into DJI Fly. */
  videoSources: () => request<{ sources: VideoSourceInfo[] }>('/api/video-sources'),
  createVideoSource: (name: string) =>
    request<{ source: VideoSourceInfo }>('/api/video-sources', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  rotateVideoSourceKey: (sn: string) =>
    request<{ source: VideoSourceInfo }>(`/api/video-sources/${encodeURIComponent(sn)}/key`, {
      method: 'POST',
    }),
  deleteVideoSource: (sn: string) =>
    request<void>(`/api/video-sources/${encodeURIComponent(sn)}`, { method: 'DELETE' }),
  zones: () => request<{ zones: Zone[] }>('/api/zones'),
  createZone: (input: ZoneInput) =>
    request<{ zone: Zone }>('/api/zones', { method: 'POST', body: JSON.stringify(input) }),
  updateZone: (id: string, input: ZoneInput) =>
    request<{ zone: Zone }>(`/api/zones/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteZone: (id: string) =>
    request<void>(`/api/zones/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  alerts: (
    filter: { active?: boolean; deviceSn?: string; before?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams()
    if (filter.active) params.set('active', '1')
    if (filter.deviceSn) params.set('deviceSn', filter.deviceSn)
    if (filter.before) params.set('before', filter.before)
    if (filter.limit) params.set('limit', String(filter.limit))
    const query = params.toString()
    return request<{ alerts: AlertRecord[] }>(`/api/alerts${query ? `?${query}` : ''}`)
  },
  acknowledgeAlert: (id: string) =>
    request<{ alert: AlertRecord }>(`/api/alerts/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
    }),
  flights: (
    filter: {
      deviceSn?: string
      from?: string
      to?: string
      before?: string
    } = {},
  ) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value)
    const query = params.toString()
    return request<{ flights: FlightSummary[] }>(`/api/flights${query ? `?${query}` : ''}`)
  },
  flight: (id: string) => request<FlightDetail>(`/api/flights/${encodeURIComponent(id)}`),
  recordings: (
    filter: {
      deviceSn?: string
      source?: 'drone' | 'upload'
      folder?: string
      q?: string
      tag?: string
      from?: string
      to?: string
      sort?: RecordingSort
      limit?: number
      offset?: number
    } = {},
  ) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filter)) if (value) params.set(key, String(value))
    const query = params.toString()
    return request<{ recordings: RecordingRecord[]; total: number }>(
      `/api/recordings${query ? `?${query}` : ''}`,
    )
  },
  activeRecordings: () => request<{ recordings: ActiveRecording[] }>('/api/recordings/active'),
  recordingTags: () => request<{ tags: RecordingTagCount[] }>('/api/recordings/tags'),
  /** `tags` replaces the whole list; a `null` note clears it; what is left out stays. */
  annotateRecording: (id: string, change: { tags?: string[]; note?: string | null }) =>
    request<{ recording: RecordingRecord }>(`/api/recordings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(change),
    }),
  startServerRecording: (sn: string) =>
    request<{ recording: ActiveRecording }>(`/api/devices/${encodeURIComponent(sn)}/recording`, {
      method: 'POST',
    }),
  stopServerRecording: (sn: string) =>
    request<void>(`/api/devices/${encodeURIComponent(sn)}/recording`, { method: 'DELETE' }),
  deleteRecording: (id: string) =>
    request<void>(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Deletes many (200 at most); videos the account may not delete are skipped and counted. */
  deleteRecordings: (ids: string[]) =>
    request<{ deleted: number; skipped: number }>('/api/recordings/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  recordingFolders: () => request<{ folders: RecordingFolder[] }>('/api/recordings/folders'),
  recordingAuto: () => request<{ drones: RecordingAutoDrone[] }>('/api/recordings/auto'),
  /** `enabled` true or false is this drone's own choice; null follows the installation's default. */
  setRecordingAuto: (sn: string, enabled: boolean | null) =>
    request<{ enabled: boolean; setting: boolean | null }>(
      `/api/devices/${encodeURIComponent(sn)}/recording/auto`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
    ),
  /** The audit trail, newest first, a page at a time. */
  audit: (filter: AuditFilter & { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filter)) if (value) params.set(key, String(value))
    return request<AuditPage>(`/api/audit?${params.toString()}`)
  },
  auditVerify: () => request<AuditIntegrity>('/api/audit/verify'),
  /** A Developer deletes audit lines: the ones named (1000 at most), or everything a filter matches. */
  auditDelete: (body: { seqs: number[] } | { all: true; filter: AuditFilter }) =>
    request<{ deleted: number }>('/api/audit/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  recordingStorage: () => request<RecordingStorage>('/api/recordings/storage'),
  /** Where the server keeps the videos, and the folder picker behind it: a Developer's. */
  recordingLocation: () => request<{ location: RecordingLocation }>('/api/recordings/location'),
  browseServerFolders: (path?: string) =>
    request<FolderListing>(
      `/api/recordings/location/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),
  makeServerFolder: (parent: string, name: string) =>
    request<{ path: string }>('/api/recordings/location/folder', {
      method: 'POST',
      body: JSON.stringify({ parent, name }),
    }),
  setRecordingLocation: (dir: string) =>
    request<{ location: RecordingLocation }>('/api/recordings/location', {
      method: 'PUT',
      body: JSON.stringify({ dir }),
    }),
  trail: (sn: string, minutes = 10) =>
    request<{ points: TrailPoint[] }>(
      `/api/devices/${encodeURIComponent(sn)}/trail?minutes=${minutes}`,
    ),
  streams: () => request<{ streams: StreamState[] }>('/api/streams'),
  updateStream: (id: string, input: { quality?: number; videoType?: string }) =>
    request<{ stream: StreamState | null }>(`/api/streams/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  adminStop: (sn: string) =>
    request<void>(`/api/devices/${encodeURIComponent(sn)}/stream/stop`, { method: 'POST' }),
  adminResume: (sn: string) =>
    request<void>(`/api/devices/${encodeURIComponent(sn)}/stream/resume`, { method: 'POST' }),
  uploadScreenshot: (sn: string, image: Blob, capturedAt: string) =>
    request<{ screenshot: ScreenshotRecord }>(
      `/api/devices/${encodeURIComponent(sn)}/screenshots?capturedAt=${encodeURIComponent(capturedAt)}`,
      { method: 'POST', body: image, headers: { 'content-type': image.type } },
    ),
  /** Deletes one still for good (row, people count and file). */
  deleteScreenshot: (id: string) =>
    request<void>(`/api/screenshots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Deletes many; stills the account may not delete are skipped and counted. */
  deleteScreenshots: (ids: string[]) =>
    request<{ deleted: number; skipped: number }>('/api/screenshots/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  screenshots: (filter: { deviceSn?: string; from?: string; to?: string; before?: string }) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value)
    const query = params.toString()
    return request<{ screenshots: ScreenshotRecord[] }>(
      `/api/screenshots${query ? `?${query}` : ''}`,
    )
  },
  people: (id: string) =>
    request<PeopleCountResponse>(`/api/screenshots/${encodeURIComponent(id)}/people`),
  countPeople: (id: string) =>
    request<PeopleCountResponse>(`/api/screenshots/${encodeURIComponent(id)}/people`, {
      method: 'POST',
    }),
  verifyPeople: (id: string, marks: PeopleMark[]) =>
    request<PeopleCountResponse>(`/api/screenshots/${encodeURIComponent(id)}/people/verification`, {
      method: 'PUT',
      body: JSON.stringify({ marks }),
    }),
}

/** Same-origin URL for a stored screenshot; the session cookie authorises it. */
/** Where the audit trail downloads from, with the filter on the screen. The session cookie goes with it. */
export function auditExportUrl(filter: AuditFilter, format: 'csv' | 'json'): string {
  const params = new URLSearchParams({ format })
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, String(value))
  return withBase(`/api/audit/export?${params.toString()}`)
}

/** The gallery's small copy of a still (about 640 px wide): a few dozen kB instead of megabytes. */
export function screenshotThumbUrl(id: string): string {
  return withBase(`/api/screenshots/${id}/thumbnail`)
}

export function screenshotImageUrl(id: string, download = false): string {
  return withBase(`/api/screenshots/${id}/image${download ? '?download=1' : ''}`)
}

/** Where a clip plays or downloads from. The browser sends the session cookie with it. */
export function recordingVideoUrl(id: string, download = false): string {
  return withBase(`/api/recordings/${encodeURIComponent(id)}/video${download ? '?download=1' : ''}`)
}

/** The picture on a video's grid card; the browser sends the session cookie with it. */
export function recordingThumbnailUrl(id: string): string {
  return withBase(`/api/recordings/${encodeURIComponent(id)}/thumbnail`)
}

export interface UploadHandle {
  promise: Promise<RecordingRecord>
  abort: () => void
}

/**
 * Uploads a video file. `fetch` cannot report how much of a body has been sent, so this uses a
 * request object that can: `onProgress` gets 0 to 1. The file is the body itself, not a form, so
 * the server writes it to disk as it arrives. The folder is created by the server if it is new.
 */
export function uploadRecording(
  file: File,
  input: { folder?: string; title?: string; sn?: string },
  onProgress?: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest()
  const params = new URLSearchParams({ file: file.name })
  if (input.folder) params.set('folder', input.folder)
  if (input.title) params.set('title', input.title)
  if (input.sn) params.set('sn', input.sn)
  const promise = new Promise<RecordingRecord>((resolve, reject) => {
    xhr.open('PUT', withBase(`/api/recordings/upload?${params.toString()}`))
    xhr.withCredentials = true
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () => {
      let body: { recording?: RecordingRecord; error?: string; message?: string } | null = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* not JSON */
      }
      if (xhr.status === 202 && body?.recording) return resolve(body.recording)
      if (xhr.status === 401) window.dispatchEvent(new Event('session-expired'))
      reject(new Error(body?.error ?? body?.message ?? `The upload failed (${xhr.status}).`))
    }
    xhr.onerror = () => reject(new Error('The connection was lost before the upload finished.'))
    xhr.onabort = () => reject(new Error('The upload was cancelled.'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}
