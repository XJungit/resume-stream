// resume-stream — client half.
//
// Loaded by the DSH web bundle loader (NOT a raw ESM module — it must be wrapped
// in window.__ModuleLoader__.load, see the gitbash plugin for the same pattern).
//
// Bundle packages have no host.call, but they DO receive the cross-process
// `session/event` firehose. The host half appends a custom `resume-stream/cut`
// event on every actual resume; here we collect those turns and render a
// conversation.chat.turnTail badge ONLY for them — so the badge appears only
// when a stream was actually resumed, not on every turn.

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
      ctx.on('session/event', function (session, event) {
        if (event && event.type === 'resume-stream/cut' && event.data && typeof event.data.turn === 'number') {
          resumedTurns[event.data.turn] = true
        }
      })

      var slots = ctx.get('slots')
      if (slots === undefined) return

      // Per-turn tail badge, but ONLY for turns in resumedTurns. turnTail is a
      // chain slot: `select` picks the owner whose tail renders; returning null
      // hides the badge. The chat re-renders on every session/event, so once a
      // resume-stream/cut arrives the matching turn's badge appears.
      slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'resume-stream-tail',
            select: function (owner) {
              if (owner && typeof owner.turn === 'number' && resumedTurns[owner.turn]) return owner
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
