import { useEffect, useRef, useState } from 'react'
import {
  FOLDER_NAME_MAX,
  VIDEO_TITLE_MAX,
  type RecordingFolder,
  type RecordingRecord,
} from '@dji/protocol'
import { uploadRecording, type UploadHandle } from '../api'
import { deviceLabel } from '../deviceSearch'
import { sizeLabel } from '../flightFormat'
import { useFleet } from '../store'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { filterControl } from '../ui/surface'
import Icon from './Icon'

/** The video types a browser can name; the server reads far more (mkv, avi, ts...) by content. */
const ACCEPT = 'video/*,.mkv,.avi,.mov,.m4v,.mts,.m2ts,.ts,.flv,.wmv,.webm,.3gp'

/** `IMG_0042.final.MP4` becomes `IMG_0042.final`: the name to suggest. */
function nameFromFile(file: string): string {
  return file
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[_]+/g, ' ')
    .trim()
}

/**
 * Upload a video into the archive: pick the file, give it a name, say which folder it goes in (a
 * folder that does not exist yet is created), and optionally which drone it came from. The file
 * is sent as it is; the server then makes it playable, which can take a while for a large file.
 */
export default function UploadVideoDialog({
  folders,
  onClose,
  onUploaded,
}: {
  folders: RecordingFolder[]
  onClose: () => void
  onUploaded: (recording: RecordingRecord) => void
}) {
  const devices = useFleet((state) => state.devices)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('')
  const [sn, setSn] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const handle = useRef<UploadHandle | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const uploading = progress !== null

  // Escape closes the dialog, but not while a file is on its way.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !uploading) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, uploading])

  function choose(next: File | null) {
    setError('')
    setFile(next)
    // A name already typed is kept; otherwise the file's own name is suggested.
    if (next && !title.trim()) setTitle(nameFromFile(next.name).slice(0, VIDEO_TITLE_MAX))
  }

  function start() {
    if (!file || uploading) return
    setError('')
    setProgress(0)
    const upload = uploadRecording(
      file,
      { folder: folder.trim() || undefined, title: title.trim() || undefined, sn: sn || undefined },
      setProgress,
    )
    handle.current = upload
    upload.promise
      .then((recording) => {
        onUploaded(recording)
        onClose()
      })
      .catch((e: Error) => {
        setError(e.message)
        setProgress(null)
      })
  }

  function cancel() {
    if (uploading) handle.current?.abort()
    else onClose()
  }

  const known = folders.some((item) => item.name.toLowerCase() === folder.trim().toLowerCase())

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !uploading) onClose()
      }}
    >
      <div
        className="max-h-[92vh] w-[min(540px,100%)] overflow-y-auto rounded-xl border border-line bg-white p-5 [box-shadow:var(--shadow-float)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-video-title"
        data-testid="upload-dialog"
      >
        <h2 id="upload-video-title" className="m-0 mb-1 text-[16px] font-semibold">
          Upload a video
        </h2>
        <p className="m-0 mb-4 text-[12px] leading-[1.55] text-ink-3">
          Keep a video recorded elsewhere here, so it can be found and played with the recordings
          from the drones.
        </p>

        <button
          type="button"
          className={cn(
            'mb-4 flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
            dragging
              ? 'border-pine bg-pine-wash'
              : 'border-line-strong bg-surface-2 hover:border-pine',
            uploading && 'pointer-events-none opacity-60',
          )}
          data-testid="upload-drop"
          onClick={() => picker.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            choose(event.dataTransfer.files[0] ?? null)
          }}
        >
          <Icon name="upload" className="size-6 text-pine" />
          {file ? (
            <>
              <span className="max-w-full truncate text-[13px] font-medium">{file.name}</span>
              <span className="font-mono text-[10.5px] text-ink-3">{sizeLabel(file.size)}</span>
            </>
          ) : (
            <>
              <span className="text-[13px] font-medium">Choose a video file, or drop it here</span>
              <span className="text-[11px] text-ink-3">
                MP4, MOV, MKV, AVI, WebM and most others
              </span>
            </>
          )}
        </button>
        <input
          ref={picker}
          className="hidden"
          type="file"
          accept={ACCEPT}
          data-testid="upload-file"
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />

        <div className="mb-3.5 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[11.5px] font-medium text-ink-2">
            <span>Name</span>
            <input
              className={cn(filterControl, 'w-full')}
              type="text"
              value={title}
              maxLength={VIDEO_TITLE_MAX}
              placeholder="What to call this video"
              disabled={uploading}
              data-testid="upload-title"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1 text-[11.5px] font-medium text-ink-2">
            <label htmlFor="upload-folder">Folder</label>
            <input
              id="upload-folder"
              className={cn(filterControl, 'w-full')}
              type="text"
              value={folder}
              maxLength={FOLDER_NAME_MAX}
              placeholder="Pick a folder below, or type a new name"
              disabled={uploading}
              autoComplete="off"
              data-testid="upload-folder"
              onChange={(event) => setFolder(event.target.value)}
            />
            {/* A list that is always on screen: the browser's own suggestion list (a datalist) stays
                hidden until something is typed, so nobody knew there were folders to pick. */}
            {folders.length > 0 ? (
              <div
                className="mt-0.5 flex flex-wrap gap-1.5"
                role="group"
                aria-label="Existing folders"
                data-testid="upload-folder-list"
              >
                {folders.map((item) => {
                  const chosen = item.name.toLowerCase() === folder.trim().toLowerCase()
                  return (
                    <button
                      key={item.name}
                      type="button"
                      disabled={uploading}
                      aria-pressed={chosen}
                      data-testid="upload-folder-option"
                      className={cn(
                        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[12px] font-medium transition-colors disabled:opacity-50',
                        chosen
                          ? 'border-pine bg-pine text-white'
                          : 'border-line-strong bg-surface-2 text-ink-2 hover:border-pine',
                      )}
                      onClick={() => setFolder(chosen ? '' : item.name)}
                    >
                      <span className="truncate">{item.name}</span>
                      <span className="font-mono text-[10px] opacity-70">{item.count}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <span className="text-[11px] font-normal text-ink-3" data-testid="upload-no-folders">
                There is no folder yet. Type a name above and it is created when the video is saved.
              </span>
            )}
            <span className="text-[11px] font-normal text-ink-3" data-testid="upload-folder-hint">
              {!folder.trim()
                ? 'Leave empty to keep it without a folder.'
                : known
                  ? 'It goes into this folder.'
                  : 'This folder is new: it is created when the video is saved.'}
            </span>
          </div>
          <label className="flex flex-col gap-1 text-[11.5px] font-medium text-ink-2">
            <span>Drone (optional)</span>
            <select
              className={cn(filterControl, 'w-full')}
              value={sn}
              disabled={uploading}
              onChange={(event) => setSn(event.target.value)}
            >
              <option value="">Not from a drone of ours</option>
              {Object.values(devices).map((device) => (
                <option key={device.sn} value={device.sn}>
                  {deviceLabel(device)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {uploading && (
          <div className="mb-3.5" data-testid="upload-progress">
            <div className="mb-1 flex justify-between font-mono text-[10.5px] text-ink-3">
              <span>{progress >= 1 ? 'Saving…' : 'Uploading, keep this page open'}</span>
              <span>{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full bg-pine transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <Notice tone="error" className="mb-3.5" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={cancel} data-testid="upload-cancel">
            {uploading ? 'Cancel upload' : 'Close'}
          </Button>
          <Button
            variant="mapPrimary"
            type="button"
            disabled={!file || uploading}
            onClick={start}
            data-testid="upload-start"
          >
            <Icon name="upload" />
            <span>Upload</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
