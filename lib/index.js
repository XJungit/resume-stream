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
// AUTO-CONTINUE: a rewritten stop ends the agent turn cleanly, which preserves
// content but stalls an in-flight task until the user nudges it — a cut during
// a thinking block leaves a dangling half-thought with no body text at all. So
// on EVERY rewritten TRANSPORT cut we queue a synthetic followup on the live
// Agent (`agents.get(id)` + `agent.followup(...)`, same mechanism
// dsh-goal-round-driver uses), and the driver opens the next turn by itself.
//
// There is deliberately NO "clean EOF vs mid-stream cut" classification: pi-ai
// reports ANY body-close without finish_reason — graceful gateway EOFs AND
// abnormal mid-generation resets alike — as the same "Stream ended without
// finish_reason" message (verified in production: an openrouter stealth cut
// mid-thinking surfaced with exactly that message). Completeness cannot be
// inferred at this layer, and a needless continuation is cheap (the synthetic
// prompt tells the model to just confirm completion) while a stalled task
// costs a manual nudge.
//
// Guards: max consecutive auto-continues per session (reset by any clean
// completion) plus a short dedupe window against concurrent double-fired
// streams.
//
// It also keeps a (best-effort persisted) hit counter and, on every actual
// resume, appends a KNOWN, inert `hook/invoked` event (name:'resume-stream-cut')
// to the live session. The client half registers a conversation Definition for
// that event, so DSH itself renders a per-turn inline badge — including after a
// history reload, because the event is part of the persisted session log.
// (A custom event type would brick session reload, hence the inert known type.)
//
// Diagnostics live in ~/.dsh/resume-stream/resume-stream.log. Only startup,
// actual resumes, continuations, and failures are logged — never per-request
// traffic. The log rotates to resume-stream.log.old once it exceeds LOG_MAX_BYTES.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@omdp/dsh-resume-stream'
export const inject = ['llm', 'sessions']

// Consolidated under the plugin's own directory (legacy root-level
// .dsh/resume-stream-count.json is read once for migration, never written).
const STORE_PATH = '.dsh/resume-stream/count.json'
const LEGACY_STORE_PATH = '.dsh/resume-stream-count.json'
const LOG_DIR = join(homedir(), '.dsh', 'resume-stream')
const LOG_PATH = join(LOG_DIR, 'resume-stream.log')
const LOG_MAX_BYTES = 256 * 1024

// Auto-continue tuning.
const MAX_AUTO_CONTINUES = 5
const AUTO_CONTINUE_DEDUPE_MS = 3000

/** sessionId -> consecutive auto-continues since the last clean completion. */
const autoChain = new Map()
/** sessionId -> epoch ms of the last queued followup (dedupe window). */
const lastQueuedAt = new Map()

// Module-level mutable state. Single source of truth for the counter.
// `loaded` gates saveStore until the persisted value settled, so a resume
// firing before the async load completes cannot clobber the stored count.
const state = { count: 0, lastProvider: null, lastAt: 0, loaded: false }

let logDirReady = false

function log(line) {
  try {
    if (!logDirReady) {
      mkdirSync(LOG_DIR, { recursive: true })
      logDirReady = true
    }
    try {
      // Rotate: keep at most one generation (.old is replaced on next cycle).
      if (statSync(LOG_PATH).size > LOG_MAX_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.old`)
    } catch {
      /* log file does not exist yet */
    }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging is best-effort */
  }
}

async function tryRead(fs, path) {
  try {
    const target = await fs.resolve(path)
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

function loadStore(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  ;(async () => {
    try {
      // Try new consolidated path, then legacy root-level file for migration.
      let text = await tryRead(fs, STORE_PATH)
      if (typeof text !== 'string' || text.length === 0) {
        text = await tryRead(fs, LEGACY_STORE_PATH)
      }
      if (typeof text === 'string' && text.length > 0) {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed.count === 'number') {
          state.count = parsed.count
          state.lastProvider = parsed.lastProvider ?? null
          state.lastAt = parsed.lastAt ?? 0
          state.loaded = true
          saveStore(ctx) // persist into the consolidated path
        }
      }
    } catch {
      /* persistence is best-effort */
    }
  })()
    .catch(() => {})
    .then(() => {
      state.loaded = true
    })
}

function saveStore(ctx) {
  if (!state.loaded) return
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
  log(
    `RESUMED transport cut -> rewritten to stop | provider=${state.lastProvider} code=${code ?? '?'} count=${state.count} turn=${turn ?? '?'} msg=${String(message ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
  )
  ctx.logger.info(
    `[resume-stream] 流式断流已自动续写（provider: ${state.lastProvider}，累计 ×${state.count}）`,
  )
  // Signal the client so it can show a badge ONLY on resumed turns.
  // We must NOT append a custom (out-of-repo) event type: dsh-session's loader
  // refuses any unknown type on reload (SessionFormatUnsupportedError), which
  // bricks the whole session. The ONLY safe cross-process channel for a bundle
  // plugin is a KNOWN session event type. `hook/invoked` is inert in this build
  // (no consumer anywhere — host does not act on it, the client does not render
  // it natively), so it carries our signal without UI conflict or side effects.
  // The client's Definition filters on data.name === 'resume-stream-cut'.
  if (session !== undefined && session !== null) {
    try {
      session.append('hook/invoked', {
        name: 'resume-stream-cut',
        provider: state.lastProvider,
        code: code ?? '?',
        count: state.count,
        turn: turn ?? null,
      })
    } catch (e) {
      log(`session.append(hook/invoked) failed: ${String(e)}`)
    }
  }
}

/**
 * Queue a synthetic followup so the agent driver opens its next turn by itself.
 * Called for every rewritten TRANSPORT cut — pi-ai reports both genuine
 * mid-generation truncations and graceful cleanup EOFs under the same "without
 * finish_reason" message, so we cannot distinguish completeness at this layer.
 */
function tryAutoContinue(ctx, sessionId, failureMessage) {
  if (sessionId === undefined || sessionId === null) return
  const now = Date.now()
  if (now - (lastQueuedAt.get(sessionId) ?? 0) < AUTO_CONTINUE_DEDUPE_MS) {
    log(`auto-continue deduped (within ${AUTO_CONTINUE_DEDUPE_MS}ms) | session=${sessionId}`)
    return
  }
  const chain = autoChain.get(sessionId) ?? 0
  if (chain >= MAX_AUTO_CONTINUES) {
    log(`auto-continue skipped: consecutive limit ${MAX_AUTO_CONTINUES} reached | session=${sessionId}`)
    ctx.logger.warn(`[resume-stream] 连续自动接续已达上限（${MAX_AUTO_CONTINUES} 次），本轮不再自动继续；如需请手动发送消息。`)
    return
  }
  const agents = ctx.get('agents')
  if (agents === undefined) return
  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    return
  }
  if (agent === undefined || typeof agent.followup !== 'function') {
    log(`auto-continue skipped: no live agent | session=${sessionId}`)
    return
  }
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [
      {
        type: 'text',
        text: '[resume-stream] 上一条回复在传输中途被切断（内容已尽量保留）。请从中断处继续完成剩余工作；若思考还未完成请继续思考，若任务已完成请直接给出简短收尾确认，不要重复已有内容。',
      },
    ],
    source: { kind: 'plugin', plugin: name },
  }
  try {
    agent.followup(message)
    lastQueuedAt.set(sessionId, now)
    autoChain.set(sessionId, chain + 1)
    log(`auto-continue queued | session=${sessionId} chain=${chain + 1}/${MAX_AUTO_CONTINUES} msg=${String(failureMessage ?? '').replace(/\s+/g, ' ').slice(0, 100)}`)
    ctx.logger.info('[resume-stream] 检测到传输中途断开，已自动排队继续本轮工作。')
  } catch (e) {
    log(`auto-continue followup failed: ${String(e)}`)
  }
}

// The turn currently being streamed: the highest turn/start in the log.
// Session events are { type, seq, time, data } — turn/start keeps the turn
// number under `data.turn` (see dsh-session SessionEventMap).
function currentTurn(session) {
  const log = session.log
  if (log === undefined || log === null) return undefined
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].type === 'turn/start') return log[i].data?.turn
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

export async function* tolerateMissingFinishReason(ctx, provider, stream, session, sessionId) {
  let rewrote = false
  let failureMessage
  for await (const chunk of stream) {
    if (isErrorFinishChunk(chunk)) {
      const turn = session !== undefined ? currentTurn(session) : undefined
      failureMessage = chunk.reason.failure?.message
      notifyCut(ctx, provider, chunk.reason.failure?.code, failureMessage, session, turn)
      yield { ...chunk, reason: { kind: 'stop' } }
      rewrote = true
      continue
    }
    yield chunk
  }
  if (sessionId === undefined) return
  if (rewrote) {
    // Stream fully drained behind a rewritten stop: decide about continuing.
    tryAutoContinue(ctx, sessionId, failureMessage)
  } else {
    // A clean completion breaks any consecutive auto-continue chain.
    autoChain.set(sessionId, 0)
  }
}

export function apply(ctx) {
  log(`apply() called | plugin=${name}`)
  loadStore(ctx)

  // resume-stream ships as a bundle package (cordis.patch.yml). Bundle packages
  // have no host.call / harness.handle — the signal channel is the session log
  // itself: every resume appends a KNOWN, inert `hook/invoked` event
  // (name:'resume-stream-cut'); the client half claims it via a conversation
  // Definition. Deliberately NO logging here — llm/stream fires on every model
  // call, and per-request disk writes are a hot-path anti-pattern.

  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    const sessions = ctx.get('sessions')
    const session =
      sessions !== undefined && options?.sessionId !== undefined
        ? sessions.get(options.sessionId)
        : undefined
    return tolerateMissingFinishReason(ctx, options?.provider, stream, session, options?.sessionId)
  })
}
