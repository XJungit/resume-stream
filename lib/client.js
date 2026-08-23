// resume-stream — client half.
//
// Loaded by the DSH web bundle loader (NOT a raw ESM module — it must be wrapped
// in window.__ModuleLoader__.load, see the gitbash plugin for the same pattern).
//
// Bundle packages have no host.call, but they DO receive the cross-process
// `session/event` firehose. The host half appends a KNOWN, inert `hook/invoked`
// event (name:'resume-stream-cut') on every actual resume; here we collect those
// turns and render a conversation.chat.turnTail badge ONLY for them — so the
// badge appears only when a stream was actually resumed, not on every turn.

window.__ModuleLoader__.load({
  id: '@omdp/dsh-resume-stream',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    // Turns that were actually resumed (fed by the host's resume-stream/cut
    // session events). The badge renders only for these.
    var resumedTurns = {}

    var CARD_BG = 'var(--dsw-alias-bg-base, #ffffff)'
    var CARD_BORDER = 'var(--dsw-alias-border-l1, #e2e8f0)'
    var AMBER = '#e8a50a'

    function Card(props) {
      return react.createElement(
        'div',
        {
          style: {
            border: '1px solid ' + CARD_BORDER,
            borderRadius: '8px',
            overflow: 'hidden',
            background: CARD_BG,
            fontSize: '13px',
            color: 'var(--dsw-alias-label-primary, #1a1a2e)',
            margin: '4px 0',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)'
          }
        },
        props.children
      )
    }

    function Header(props) {
      return react.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 12px',
            minHeight: '24px'
          }
        },
        react.createElement('span', {
          'aria-hidden': true,
          style: { width: '8px', height: '8px', borderRadius: '50%', background: AMBER, flex: 'none' }
        }),
        react.createElement('span', { style: { fontWeight: 600 } }, props.title),
        react.createElement('span', { style: { flex: 1 } }),
        props.right
          ? react.createElement(
              'span',
              { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)' } },
              props.right
            )
          : null
      )
    }

    // Shown ONLY for turns that were actually resumed (present in resumedTurns).
    function TailNotice(ctx) {
      return react.createElement(
        Card,
        null,
        react.createElement(Header, {
          title: '🔁 本轮回流已自动补全',
          right: 'TRANSPORT 容错'
        }),
        react.createElement(
          'div',
          { style: { padding: '0 12px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #555)' } },
          '缺失 finish_reason / 连接被提前关闭时，已自动补完而非从零重试。'
        )
      )
    }

    function apply(ctx) {
      // Collect resumed turns from the host-emitted session event (cross-process).
      // The host appends a KNOWN, inert type `hook/invoked` (name:'resume-stream-cut')
      // — a custom type would brick session reload (SessionFormatUnsupportedError),
      // and other known types drive their own UI. hook/invoked has no consumer in
      // this build, so it carries our signal cleanly.
      ctx.on('session/event', function (session, event) {
        if (
          event &&
          event.type === 'hook/invoked' &&
          event.data &&
          event.data.name === 'resume-stream-cut' &&
          typeof event.data.turn === 'number'
        ) {
          resumedTurns[event.data.turn] = true
        }
      })

      var slots = ctx.get('slots')
      if (slots === undefined) return

      // Per-turn tail badge, but ONLY for turns in resumedTurns. turnTail is a
      // chain slot: `select` picks the owner whose tail renders; returning null
      // hides the badge. The chat re-renders on every session/event, so once a
      // hook/invoked(resume-stream-cut) arrives the matching turn's badge appears.
      // NOTE: owner.turn may be a Turn object (DSH passes node.location.turn),
      // so the numeric turn is owner.turn.turn when owner.turn is not a number.
      function turnOf(owner) {
        if (!owner) return undefined
        if (typeof owner.turn === 'number') return owner.turn
        if (owner.turn && typeof owner.turn.turn === 'number') return owner.turn.turn
        return undefined
      }
      slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'resume-stream-tail',
            select: function (owner) {
              var t = turnOf(owner)
              if (t !== undefined && resumedTurns[t]) return owner
              return null
            }
          },
          function () {
            return TailNotice(ctx)
          }
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
