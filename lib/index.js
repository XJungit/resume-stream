// resume-stream — host half.
//
// Hooks the host-level `llm/stream` waterfall (shared LlmRuntime service, so it
// fires for EVERY provider, not just opencode) and rewrites the terminal error
// finish chunk emitted when a backend drops the connection without completing
// the stream:
//
//   {"choices":[],"cost":"0"}  ->  pi-ai throws "Stream ended without finish_reason"
//   ...or any other transport-level truncation (premature close, ECONNRESET,
//   "other side closed", HTTP/2 no response) -> LlmError code TRANSPORT
//
// into a normal stop. Everything already streamed (text + usage) is preserved,
// so the model continues from where it was instead of restarting from zero.
//
// It also keeps a (best-effort persisted) hit counter and exposes it to the
// client half via a Package-private RPC so the UI can show it.
//
// Execution + rewrite events are logged to ~/.dsh/resume-stream/resume-stream.log
// so you can confirm the hook is loaded and actually firing.

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@omdp/dsh-resume-stream'
export const inject = ['llm']

const STORE_PATH = '.dsh/resume-stream-count.json'
const LOG_DIR = join(homedir(), '.dsh', 'resume-stream')
const LOG_PATH = join(LOG_DIR, 'resume-stream.log')

// Module-level mutable state. Single source of truth for the counter.
const state = { count: 0, lastProvider: null, lastAt: 0 }

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging is best-effort */
  }
}

function loadStore(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  try {
    fs.resolve(STORE_PATH)
      .then((target) => fs.readText(target))
      .then((text) => {
        if (typeof text === 'string' && text.length > 0) {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed.count === 'number') {
            state.count = parsed.count
            state.lastProvider = parsed.lastProvider ?? null
            state.lastAt = parsed.lastAt ?? 0
          }
        }
      })
      .catch(() => {})
  } catch {
    /* persistence is best-effort */
  }
}

function saveStore(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  try {
    fs.resolve(STORE_PATH)
      .then((target) => fs.writeText(target, JSON.stringify(state)))
      .catch(() => {})
  } catch {
    /* persistence is best-effort */
  }
}

function notifyCut(ctx, provider, code, message) {
  state.count += 1
  state.lastProvider = provider ?? '未知'
  state.lastAt = Date.now()
  saveStore(ctx)
  log(`RESUMED transport cut -> rewritten to stop | provider=${state.lastProvider} code=${code ?? '?'} count=${state.count} msg=${(message ?? '').slice(0, 200)}`)
  ctx.logger.info(
    `[resume-stream] 流式断流已自动续写（provider: ${state.lastProvider}，累计 ×${state.count}）`,
  )
}

// The Zen/opencode gateway closes the SSE body without a finish_reason; pi-ai's
// openai-completions adapter turns that into a terminal error finish chunk. The
// dsh-llm-pi-ai adapter converts the low-level transport failure into an
// in-band `finish{kind:'error', failure:{code:'TRANSPORT'}}` chunk before
// llm/stream (see dsh-llm-pi-ai/lib/index.js classifyPiAiError:1273 +
// mapStopReason error path). At this layer we only ever see the chunk, never
// the exception.
//
// Scope: only TRANSPORT-class cuts are safe to "continue" — the body was cut
// AFTER content already arrived, so the partial text/usage is valid. Real
// failures (AUTH/QUOTA/RATE_LIMIT/SERVER/CONTEXT_WINDOW_EXCEEDED/PI_AI_ERROR)
// and throw-style errors (e.g. "stream idle timeout") carry no usable body and
// must NOT be silently rewritten to stop — they belong to retry, not resume.
export function isErrorFinishChunk(chunk) {
  return (
    chunk &&
    chunk.type === 'finish' &&
    chunk.reason &&
    chunk.reason.kind === 'error' &&
    chunk.reason.failure?.code === 'TRANSPORT'
  )
}

export async function* tolerateMissingFinishReason(ctx, provider, stream) {
  for await (const chunk of stream) {
    if (isErrorFinishChunk(chunk)) {
      notifyCut(ctx, provider, chunk.reason.failure?.code, chunk.reason.failure?.message)
      yield { ...chunk, reason: { kind: 'stop' } }
      continue
    }
    yield chunk
  }
}

export function apply(ctx, harness) {
  log(`apply() called | plugin=${name}`)
  loadStore(ctx)
  log('counter state loaded: ' + JSON.stringify(state))

  // Package-private RPC: client half polls this for the live counter.
  // `harness` is the Host Builtin injected as the 2nd apply argument.
  if (typeof harness?.handle === 'function') {
    harness.handle('resumeStreamGetState', () => ({
      count: state.count,
      lastProvider: state.lastProvider,
      lastAt: state.lastAt,
    }))
    log('RPC resumeStreamGetState registered')
  } else {
    log('WARN: harness.handle unavailable — client counter/RPC disabled')
  }

  ctx.on('llm/stream', (options, next) => {
    log(`llm/stream hook fired | provider=${options?.provider ?? '?'} model=${options?.model ?? '?'}`)
    const stream = next()
    return tolerateMissingFinishReason(ctx, options?.provider, stream)
  })
  log('llm/stream listener registered (all providers)')
}
