import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { FolderListing, RecordingLocation } from '@dji/protocol'
import { api } from '../api'
import { sizeLabel } from '../flightFormat'
import Button from '../ui/Button'
import Notice from '../ui/Notice'
import { cn } from '../ui/cn'
import { filterControl } from '../ui/surface'
import Icon from './Icon'

/**
 * Choose the folder on the SERVER's disk where the videos are kept. A web page cannot see the server's
 * disk, so the server lists its own folders here, one level at a time: open folders to move into them,
 * make a new one, then press "Use this folder". Nothing is copied: videos already saved stay where they
 * are and keep playing, and new ones go to the new folder.
 */
export default function StorageFolderDialog({
  current,
  onClose,
  onChanged,
}: {
  current: RecordingLocation
  onClose: () => void
  onChanged: () => void
}) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [typed, setTyped] = useState(current.dir)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const open = useCallback(async (path?: string) => {
    setLoading(true)
    setError('')
    try {
      const result = await api.browseServerFolders(path)
      setListing(result)
      setTyped(result.path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void open(current.dir)
  }, [open, current.dir])

  async function makeFolder(event: FormEvent) {
    event.preventDefault()
    if (!listing || !newName.trim()) return
    setBusy(true)
    setError('')
    try {
      const made = await api.makeServerFolder(listing.path, newName.trim())
      setNewName('')
      await open(made.path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function use() {
    if (!listing) return
    setBusy(true)
    setError('')
    try {
      await api.setRecordingLocation(listing.path)
      onChanged()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const same = listing?.path === current.dir

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="flex max-h-[92vh] w-[min(560px,100%)] flex-col overflow-hidden rounded-xl border border-line bg-white p-5 [box-shadow:var(--shadow-float)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-folder-title"
        data-testid="storage-folder-dialog"
      >
        <h2 id="storage-folder-title" className="m-0 mb-1 text-[16px] font-semibold">
          Where to keep the videos
        </h2>
        <p className="m-0 mb-3 text-[12px] leading-[1.55] text-ink-3">
          {current.roots.length > 0
            ? 'Choose a storage area of this server, then a folder inside it. '
            : 'This is a folder on the server’s own disk, not on your computer. Choose a disk with plenty of room. '}
          Videos already saved stay where they are and keep playing; new ones go to the folder you
          choose.
        </p>

        {listing && listing.shortcuts.length > 1 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="folder-shortcuts">
            <span className="mr-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
              {current.roots.length > 0 ? 'Storage areas' : 'Go to'}
            </span>
            {listing.shortcuts.map((item) => (
              <button
                key={item.path}
                type="button"
                disabled={busy}
                className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-line-strong bg-surface-2 px-2.5 py-1 font-sans text-[11.5px] font-medium text-ink-2 hover:border-pine disabled:opacity-50"
                onClick={() => void open(item.path)}
              >
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        )}

        <form
          className="mb-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void open(typed.trim())
          }}
        >
          <Button
            variant="secondary"
            type="button"
            disabled={!listing?.parent || busy}
            aria-label="Up one folder"
            data-testid="folder-up"
            onClick={() => listing?.parent && void open(listing.parent)}
          >
            <Icon name="back" />
          </Button>
          <input
            className={cn(filterControl, 'min-w-0 flex-1 font-mono')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label="Folder path"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            data-testid="folder-path"
          />
          <Button variant="secondary" type="submit" disabled={busy}>
            Go
          </Button>
        </form>

        <div
          className="mb-2 min-h-[150px] flex-1 overflow-y-auto rounded-md border border-line bg-surface-2"
          data-testid="folder-list"
        >
          {loading && <div className="p-3 text-[12px] text-ink-3">Loading…</div>}
          {!loading && listing && listing.folders.length === 0 && (
            <div className="p-3 text-[12px] text-ink-3">
              No folders in here. Make one below, or use this folder.
            </div>
          )}
          {!loading &&
            listing?.folders.map((item) => (
              <button
                key={item.path}
                type="button"
                disabled={busy}
                className="flex w-full cursor-pointer items-center gap-2 border-0 border-b border-line-soft bg-transparent px-3 py-2 text-left font-sans text-[12.5px] text-ink hover:bg-pine-wash disabled:opacity-50"
                data-testid="folder-item"
                onClick={() => void open(item.path)}
              >
                <Icon name="folder" className="size-4 shrink-0 text-ink-3" />
                <span className="truncate">{item.name}</span>
              </button>
            ))}
          {listing?.truncated && (
            <div className="p-3 text-[11px] text-ink-3">
              Only the first folders are shown. Type the path above to go to another one.
            </div>
          )}
        </div>

        <form className="mb-3 flex gap-2" onSubmit={makeFolder}>
          <input
            className={cn(filterControl, 'min-w-0 flex-1')}
            placeholder="New folder name"
            value={newName}
            maxLength={80}
            onChange={(event) => setNewName(event.target.value)}
            disabled={busy || !listing}
            aria-label="New folder name"
            data-testid="folder-new-name"
          />
          <Button
            variant="secondary"
            type="submit"
            disabled={busy || !newName.trim() || !listing}
            data-testid="folder-new"
          >
            <Icon name="plus" />
            <span>New folder</span>
          </Button>
        </form>

        {listing && (
          <div className="mb-3 rounded-md border border-line bg-pine-wash px-3 py-2 text-[12px]">
            <div className="text-ink-3">The videos will be kept in</div>
            <div
              className="break-all font-mono text-[12.5px] font-medium"
              data-testid="folder-chosen"
            >
              {listing.path}
            </div>
            {listing.freeBytes != null && (
              <div className="mt-0.5 text-[11px] text-ink-3" data-testid="folder-free">
                Free on this disk: {sizeLabel(listing.freeBytes)}
                {listing.totalBytes ? ` of ${sizeLabel(listing.totalBytes)}` : ''}
              </div>
            )}
            <div className="mt-0.5 text-[11px] text-ink-3">
              {!listing.writable
                ? 'The server cannot write into this folder. Choose another.'
                : same
                  ? 'This is the folder in use now.'
                  : current.clips > 0
                    ? `The ${current.clips} video${current.clips === 1 ? '' : 's'} already saved (${sizeLabel(current.usedBytes)}) stay in the old folder and keep playing.`
                    : 'Nothing is saved yet, so nothing needs to be moved.'}
            </div>
          </div>
        )}

        {error && (
          <Notice tone="error" className="mb-3" onDismiss={() => setError('')}>
            {error}
          </Notice>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant="mapPrimary"
            type="button"
            disabled={!listing || !listing.writable || same || busy}
            onClick={() => void use()}
            data-testid="folder-use"
          >
            <Icon name="check" />
            <span>Use this folder</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
