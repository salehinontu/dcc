import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  cleanTag,
  cleanTags,
  RECORDING_NOTE_MAX,
  RECORDING_TAGS_MAX,
  type RecordingRecord,
} from '@dji/protocol'
import { api } from '../api'
import Button from '../ui/Button'
import { cn } from '../ui/cn'
import Icon from './Icon'

/** A small label that carries a tag; a button when it can be pressed (to filter by it). */
export function TagChip({
  name,
  onPress,
  onRemove,
  className,
}: {
  name: string
  onPress?: () => void
  onRemove?: () => void
  className?: string
}) {
  const base =
    'inline-flex max-w-full items-center gap-1 rounded-[999px] border border-line bg-sunken px-2 py-px text-[10.5px] leading-[1.5] text-ink-2'
  return (
    <span className={cn(base, className)} data-testid="recording-tag">
      {onPress ? (
        <button
          type="button"
          className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-inherit hover:text-pine-strong hover:underline"
          title={`Show videos tagged ${name}`}
          onClick={onPress}
        >
          {name}
        </button>
      ) : (
        <span className="min-w-0 truncate">{name}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className="grid size-3.5 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-ink-3 hover:bg-line hover:text-ink [&_svg]:size-2.5"
          aria-label={`Remove the tag ${name}`}
          onClick={onRemove}
        >
          <Icon name="x" />
        </button>
      )}
    </span>
  )
}

/**
 * The tags and the note of one video. Anyone who can see the video reads them; whoever may label it adds and removes
 * tags (saved at once) and writes the note (saved with its button). The search on the screen finds a video by either.
 */
export default function RecordingNotes({
  clip,
  mayEdit,
  suggestions,
  onSaved,
  onError,
}: {
  clip: RecordingRecord
  mayEdit: boolean
  /** Tags already in use, offered while typing. */
  suggestions: string[]
  onSaved: (updated: RecordingRecord) => void
  onError: (message: string) => void
}) {
  const listId = useId()
  const [draft, setDraft] = useState(clip.note ?? '')
  const [typed, setTyped] = useState('')
  // Saves wait for each other and each starts from the tags the last one left, so a tag typed while another is still
  // being saved is added to it, not lost, and the box never has to stop accepting keys.
  const [pending, setPending] = useState(0)
  const [saved, setSaved] = useState(false)
  const latest = useRef(clip.tags)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const busy = pending > 0

  // Another video was opened, or this one changed elsewhere: start from what the server says.
  useEffect(() => {
    setDraft(clip.note ?? '')
    setTyped('')
    setSaved(false)
  }, [clip.id, clip.note])
  useEffect(() => {
    latest.current = clip.tags
  }, [clip.id, clip.tags])

  function enqueue(work: () => Promise<boolean>): Promise<boolean> {
    setPending((n) => n + 1)
    const next = queue.current
      .catch(() => undefined)
      .then(work)
      .finally(() => setPending((n) => n - 1))
    queue.current = next
    return next
  }

  async function persist(change: { tags?: string[]; note?: string | null }): Promise<boolean> {
    try {
      const { recording } = await api.annotateRecording(clip.id, change)
      latest.current = recording.tags
      onSaved(recording)
      return true
    } catch (e) {
      onError((e as Error).message)
      return false
    }
  }

  function addTags(raw: string) {
    const added = cleanTags(raw.split(/[,;\n]/))
    setTyped('')
    if (added.length === 0) return
    void enqueue(async () => {
      const next = cleanTags([...latest.current, ...added])
      if (next.length === latest.current.length) return true
      return persist({ tags: next })
    })
  }

  function removeTag(tag: string) {
    void enqueue(() => persist({ tags: latest.current.filter((item) => item !== tag) }))
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    // The box's own value, not the last render's: keys can arrive faster than React draws.
    const value = event.currentTarget.value
    if (event.key === 'Enter') {
      event.preventDefault()
      addTags(value)
    } else if (event.key === 'Backspace' && value === '' && latest.current.length > 0 && mayEdit) {
      // Backspace in an empty box takes back the last tag, as in most tag boxes.
      void enqueue(() => persist({ tags: latest.current.slice(0, -1) }))
    }
  }

  const changed = (draft.trim() === '' ? null : draft.trim()) !== clip.note
  const options = suggestions.filter(
    (name) => !clip.tags.some((tag) => tag.toLowerCase() === name.toLowerCase()),
  )

  return (
    <div className="grid gap-3 border-t border-line px-3.5 py-3" data-testid="recording-notes">
      <div>
        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
          Tags
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {clip.tags.length === 0 && !mayEdit && (
            <span className="text-[12px] text-ink-3">No tags.</span>
          )}
          {clip.tags.map((tag) => (
            <TagChip
              key={tag.toLowerCase()}
              name={tag}
              onRemove={mayEdit ? () => removeTag(tag) : undefined}
            />
          ))}
          {mayEdit && clip.tags.length < RECORDING_TAGS_MAX && (
            <>
              <input
                className="h-7 w-[210px] max-w-full rounded-md border border-line-strong bg-surface-2 px-2.5 text-[12px] outline-none focus:border-pine"
                value={typed}
                maxLength={400}
                list={listId}
                placeholder="Add a tag, press Enter"
                aria-label="Add a tag"
                data-testid="recording-tag-input"
                onChange={(event) => {
                  // A comma (typed, or in a pasted list) ends a tag: add the finished ones, keep what follows.
                  const value = event.target.value
                  if (!/[,;\n]/.test(value)) return setTyped(value)
                  const parts = value.split(/[,;\n]/)
                  const rest = parts.pop() ?? ''
                  addTags(parts.join(','))
                  setTyped(rest)
                }}
                onKeyDown={onKey}
                onBlur={(event) => {
                  if (cleanTag(event.currentTarget.value)) addTags(event.currentTarget.value)
                }}
              />
              <datalist id={listId}>
                {options.slice(0, 50).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
          Note
        </div>
        {mayEdit ? (
          <>
            <textarea
              className="block min-h-[72px] w-full max-w-[760px] resize-y rounded-md border border-line-strong bg-surface-2 px-2.5 py-2 text-[12.5px] leading-[1.5] outline-none focus:border-pine"
              value={draft}
              maxLength={RECORDING_NOTE_MAX}
              placeholder="What is in this video? Who should look at it, and why?"
              aria-label="Note"
              data-testid="recording-note-input"
              onChange={(event) => {
                setDraft(event.target.value)
                setSaved(false)
              }}
            />
            <div className="mt-1.5 flex items-center gap-2.5">
              <Button
                variant="secondary"
                type="button"
                disabled={!changed || busy}
                data-testid="recording-note-save"
                onClick={async () => {
                  if (await enqueue(() => persist({ note: draft.trim() === '' ? null : draft })))
                    setSaved(true)
                }}
              >
                Save note
              </Button>
              {changed && !busy && <span className="text-[11px] text-ink-3">Not saved yet</span>}
              {saved && !changed && (
                <span className="inline-flex items-center gap-1 text-[11px] text-ok">
                  <Icon name="check" className="size-3" />
                  Saved
                </span>
              )}
              <span className="ml-auto font-mono text-[10px] text-ink-3">
                {draft.length}/{RECORDING_NOTE_MAX}
              </span>
            </div>
          </>
        ) : (
          <p
            className="m-0 whitespace-pre-wrap text-[12.5px] leading-[1.5] text-ink-2"
            data-testid="recording-note-text"
          >
            {clip.note ?? <span className="text-ink-3">No note.</span>}
          </p>
        )}
      </div>
    </div>
  )
}
