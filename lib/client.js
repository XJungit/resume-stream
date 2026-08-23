// resume-stream — client half.
//
// Loaded by the DSH web bundle loader (NOT a raw ESM module — it must be wrapped
// in window.__ModuleLoader__.load, see the gitbash plugin for the same pattern).
//
// How the badge reaches the screen: the host half appends a KNOWN, inert
// `hook/invoked` event (data.name === 'resume-stream-cut', data.turn = N) into
// the live session on every actual resume (a custom event type would brick
// session reload). On this page the DSH client runtime folds every session
// event through its conversation pipeline: plugins REGISTER a business
// Definition on ctx.conversationEvents whose match(event) claims only their own
// events, plus a keyed renderer on the conversation.chat.node slot. DSH then
// renders the badge inline in the message flow itself — including after a
// history reload, because the event is part of the persisted log.
//
// NOTE: there is deliberately NO ctx.on('session/event', …) here. The client
// runtime never re-emits session frames onto the plugin event bus (its mux
// feeds an internal mirror only), so that listener would silently never fire.

window.__ModuleLoader__.load({
  id: '@omdp/dsh-resume-stream',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

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

    // Keyed Chat renderer for nodes built by resumeCutDefinition below.
    // Node slot views receive { node, t }; our payload rides node.data.
    function ResumeCutNodeView(props) {
      var node = props && props.node
      var data = (node && node.data) || {}
      var detail =
        '缺失 finish_reason / 连接被提前关闭时，已自动补完而非从零重试。' +
        (typeof data.turn === 'number' ? '（第 ' + data.turn + ' 轮）' : '')
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
          detail
        )
      )
    }

    // Business Definition claiming ONLY our own events: match returning null
    // hands every other event back to the pipeline untouched, so registering
    // for the (otherwise unused) hook/invoked type cannot disturb native UI.
    var resumeCutDefinition = {
      kind: 'resume-stream-cut',
      target: 'chat',
      match: function (event) {
        if (
          event &&
          event.type === 'hook/invoked' &&
          event.data &&
          event.data.name === 'resume-stream-cut'
        ) {
          return { id: 'resume-stream-cut-' + event.seq, role: 'start' }
        }
        return null
      },
      start: function (_context, match) {
        return {
          turn: typeof match.event.data.turn === 'number' ? match.event.data.turn : null,
          provider: match.event.data.provider,
          seq: match.event.seq
        }
      },
      update: function (context) {
        return context.state
      },
      buildViewNode: function (context) {
        if (context.state === undefined) return null
        var location =
          (context.start && context.start.location) ||
          (context.matches && context.matches[0] && context.matches[0].location) ||
          { kind: 'unresolved' }
        var anchorSeq =
          (context.matches && context.matches[0] && context.matches[0].event && context.matches[0].event.seq) ||
          context.state.seq ||
          0
        return {
          key: context.key,
          kind: 'resume-stream-cut',
          id: context.id,
          target: 'chat',
          anchorSeq: anchorSeq,
          location: location,
          visibility: 'visible',
          data: { turn: context.state.turn, provider: context.state.provider }
        }
      }
    }

    function apply(ctx) {
      // Claim our events in the conversation pipeline (lifetime-tied to us).
      var conversationEvents = ctx.get('conversationEvents')
      if (conversationEvents !== undefined) {
        ctx.effect(function () {
          return conversationEvents.register(resumeCutDefinition)
        }, 'resume-stream: conversation definition')
      }

      var slots = ctx.get('slots')
      if (slots === undefined) return

      // Render nodes of our kind inside the chat flow.
      slots.inject('conversation.chat.node', function () {
        return slots.register(
          {
            name: 'conversation.chat.node',
            key: 'resume-stream-cut'
          },
          ResumeCutNodeView
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
