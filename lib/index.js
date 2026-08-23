// resume-stream — host half.
//
// Hooks the host-level `llm/stream` waterfall (shared LlmRuntime service, so it
// fires for EVERY provider, not just opencode) and rewrites the terminal error
// finish chunk emitted when a backend drops the connection without sending a
// finish_reason:
//
//   {"choices":[],"cost":"0"}  ->  pi-ai throws "Stream ended without finish_reason"
//
// into a normal stop. Everything already streamed (text + usage) is preserved,
// so the model continues from where it was instead of restarting from zero.
//
// It also keeps a (best-effort persisted) hit counter and exposes it to the
// client half via a Package-private RPC so the UI can show it.

export const name = '@omdp/dsh-resume-stream'
export const inject = ['llm']

const MISSING_FINISH_REASON = 'Stream ended without finish_reason'
const STORE_PATH = '.dsh/resume-stream-count.json'

// Module-level mutable state. Single source of truth for the counter.
const state = { count: 0, lastProvider: null, lastAt: 0 }

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

function notifyCut(ctx, provider) {
  state.count += 1
  state.lastProvider = provider ?? '未知'
  state.lastAt = Date.now()
  saveStore(ctx)
  ctx.logger.info(
    `[resume-stream] 流式断流已自动续写（provider: ${state.lastProvider}，累计 ×${state.count}）`,
  )
}

// The Zen/opencode gateway closes the SSE body without a finish_reason; pi-ai's
// openai-completions adapter turns that into a terminal error finish chunk. The
// dsh-llm-pi-ai adapter converts the low-level throw into an in-band
// `finish{kind:'error',failure}` chunk before llm/stream (see
// dsh-llm-pi-ai/lib/index.js:1328-1330 + 1437-1446), so at this layer we only
// ever see the chunk, never the exception. Rewrite that exact chunk into a clean
// stop; everything already streamed (text + usage) is preserved, so the model
// resumes in place.
function isErrorFinishChunk(chunk) {
  return (
    chunk &&
    chunk.type === 'finish' &&
    chunk.reason &&
    chunk.reason.kind === 'error' &&
    chunk.reason.failure &&
    chunk.reason.failure.message === MISSING_FINISH_REASON
  )
}

async function* tolerateMissingFinishReason(ctx, provider, stream) {
  for await (const chunk of stream) {
    if (isErrorFinishChunk(chunk)) {
      notifyCut(ctx, provider)
      yield { ...chunk, reason: { kind: 'stop' } }
      continue
    }
    yield chunk
  }
}

export function apply(ctx) {
  ctx.logger.info('[resume-stream] stream-compat hook active (all providers)')
  loadStore(ctx)

  // Package-private RPC: client half polls this for the live counter.
  if (typeof harness !== 'undefined' && typeof harness.handle === 'function') {
    harness.handle('resumeStreamGetState', () => ({
      count: state.count,
      lastProvider: state.lastProvider,
      lastAt: state.lastAt,
    }))
  }

  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    return tolerateMissingFinishReason(ctx, options?.provider, stream)
  })
}
