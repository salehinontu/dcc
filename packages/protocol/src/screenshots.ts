/**
 * A still frame captured from a live feed and stored on the server. Image bytes are served
 * by `GET /api/screenshots/{id}/image`; the record never exposes a filesystem path.
 */
export interface ScreenshotRecord {
  id: string
  deviceSn: string
  /** Display name of the aircraft when the frame was captured. */
  deviceLabel: string | null
  missionId: string | null
  filename: string
  contentType: string
  sizeBytes: number
  width: number | null
  height: number | null
  capturedAt: string
  operatorId: string | null
  operatorEmail: string | null
  lat: number | null
  lon: number | null
  altRel: number | null
  /** People counted on this still, or null when nobody has run a count. */
  people: { aiCount: number; verifiedCount: number | null } | null
}

/** One person the model found, as fractions of the frame: top-left corner, size, confidence. */
export interface PeopleDetection {
  x: number
  y: number
  w: number
  h: number
  score: number
  /** Confident enough to count. The others are possible people for the operator to judge. */
  counted: boolean
}

/** One person in a verified count, at the centre of where they stand, as frame fractions. */
export interface PeopleMark {
  x: number
  y: number
  /** `ai` marks were kept from the model's detections; `manual` ones an operator added. */
  source: 'ai' | 'manual'
}

/**
 * People on a screenshot. `aiCount` is the model's estimate; `verifiedCount` is set once an
 * operator has checked every mark, and is the number to report.
 */
export interface PeopleCount {
  screenshotId: string
  /**
   * `quick` is the fast first estimate; `thorough` the slower, more careful scan that
   * replaces it, usually within a minute of the capture.
   */
  stage: 'quick' | 'thorough'
  model: string
  aiCount: number
  detections: PeopleDetection[]
  durationMs: number | null
  analyzedAt: string
  analyzedBy: string | null
  verifiedCount: number | null
  marks: PeopleMark[] | null
  verifiedAt: string | null
  verifiedBy: string | null
}

/** `GET`/`POST /api/screenshots/{id}/people` and `PUT …/people/verification`. */
export interface PeopleCountResponse {
  /** False when the counting model is not installed on the server. */
  available: boolean
  /** Whether this account may save a verified count for the aircraft. */
  canVerify: boolean
  /** The model is running on this still right now (for example started by the capture). */
  counting: boolean
  people: PeopleCount | null
}
