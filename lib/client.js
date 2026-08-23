// resume-stream — client half.
//
// Loaded by the DSH web bundle loader (NOT a raw ESM module — it must be wrapped
// in window.__ModuleLoader__.load, see the gitbash plugin for the same pattern).
//
// Bundle packages have no Client↔Host RPC (host.call) and cannot observe custom
// host→client data, so the live cut counter cannot be rendered here. The single
// UI surface is a STATIC badge in conversation.chat.turnTail telling the user
// auto-resume is active. A live count / toast requires rebuilding as a dynamic
// cordis plugin (which gets `harness.handle`/`host.call`).

window.__ModuleLoader__.load({
  id: '@omdp/dsh-resume-stream',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    // Local cache of the latest counter snapshot (refreshed by the poller).
    var cache = { count: 0, lastProvider: null, lastAt: 0 }

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

    // Bundle packages have no Client↔Host RPC (host.call) and cannot observe
    // custom host→client data, so the live counter cannot be shown here. This
    // notice is a STATIC badge: it tells the user auto-resume is active, but it
    // does not count cuts (that needs a dynamic cordis plugin with host.call).
    function TailNotice(ctx) {
      return react.createElement(
        Card,
        null,
        react.createElement(Header, {
          title: '🔁 自动续流已启用',
          right: 'TRANSPORT 容错'
        }),
        react.createElement(
          'div',
          { style: { padding: '0 12px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #555)' } },
          '缺失 finish_reason / 连接被提前关闭时，会自动补完而非从零重试。'
        )
      )
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return

      // Persistent inline badge in the message list (after every completed turn).
      slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          { name: 'conversation.chat.turnTail', id: 'resume-stream-tail' },
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
