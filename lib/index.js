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
// It also keeps a (best-effort persisted) hit counter and, on every actual
// resume, appends a custom session event `resume-stream/cut` to the live
// session. The client half subscribes to `session/event` and shows a per-turn
// tail badge ONLY for turns that were resumed — the bundle-package-correct
// host→client channel (bundle packages have no host.call).
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

function notifyCut(ctx, provider, code, message, session, turn) {
  state.count += 1
  state.lastProvider = provider ?? '未知'
  state.lastAt = Date.now()
  saveStore(ctx)
  log(`RESUMED transport cut -> rewritten to stop | provider=${state.lastProvider} code=${code ?? '?'} count=${state.count} turn=${turn ?? '?'} msg=${(message ?? '').slice(0, 200)}`)
  ctx.logger.info(
    `[resume-stream] 流式断流已自动续写（provider: ${state.lastProvider}，累计 ×${state.count}）`,
  )
  // Emit a custom session event so the client can show a badge ONLY on resumed
  // turns. session/event is the cross-process firehose; custom types are allowed
  // at runtime (assertSupportedRequestHeader only rejects legacy request/header).
  if (session !== undefined && session !== null) {
    try {
      session.append('resume-stream/cut', {
        provider: state.lastProvider,
        code: code ?? '?',
        count: state.count,
        turn: turn ?? null,
      })
    } catch (e) {
      log(`session.append(resume-stream/cut) failed: ${String(e)}`)
    }
  }
}

// The turn currently being streamed: the highest turn/start seq in the log.
function currentTurn(session) {
  const log = session.log
  if (log === undefined || log === null) return undefined
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].type === 'turn/start') return log[i].turn
  }
  return undefined
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

export async function* tolerateMissingFinishReason(ctx, provider, stream, session) {
  for await (const chunk of stream) {
    if (isErrorFinishChunk(chunk)) {
      const turn = session !== undefined ? currentTurn(session) : undefined
      notifyCut(ctx, provider, chunk.reason.failure?.code, chunk.reason.failure?.message, session, turn)
      yield { ...chunk, reason: { kind: 'stop' } }
      continue
    }
    yield chunk
  }
}

export function apply(ctx) {
  log(`apply() called | plugin=${name}`)
  loadStore(ctx)
  log('counter state loaded: ' + JSON.stringify(state))

  // resume-stream ships as a bundle package (cordis.patch.yml). Bundle packages
  // have no host.call / harness.handle — but they DO have the cross-process
  // `session/event` firehose. On every resume we append a custom
  // `resume-stream/cut` session event (runtime-allowed custom type); the client
  // half subscribes and shows a per-turn tail badge ONLY for resumed turns.

  ctx.on('llm/stream', (options, next) => {
    log(`llm/stream hook fired | provider=${options?.provider ?? '?'} model=${options?.model ?? '?'}`)
    const stream = next()
    const sessions = ctx.get('sessions')
    const session = sessions !== undefined && options?.sessionId !== undefined
      ? sessions.get(options.sessionId)
      : undefined
    return tolerateMissingFinishReason(ctx, options?.provider, stream, session)
  })
  log('llm/stream listener registered (all providers)')
}
