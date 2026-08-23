// resume-stream — client half.
//
// Loaded by the DSH web bundle loader (NOT a raw ESM module — it must be wrapped
// in window.__ModuleLoader__.load, see the gitbash plugin for the same pattern).
//
// Two UI surfaces:
//   1. shell.overlay  -> a transient gitbash-style toast on each new cut.
//   2. conversation.chat.turnTail -> a persistent inline notice (with the
//      hit counter) rendered inside the message list after each completed turn.
//
// Both poll the host half over the Package-private RPC `resumeStreamGetState`
// (host registers it via harness.handle; this half reads it via host.call).

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

    // Pull the live counter from the host half. Re-renders on every poll tick.
    function useResumed(ctx) {
      var data = react.useState(cache)
      var setData = data[1]
      react.useEffect(function () {
        var alive = true
        var tick = function () {
          if (!alive) return
          host
            .call('resumeStreamGetState')
            .then(function (res) {
              if (res && typeof res.count === 'number') {
                cache = res
                setData(res)
              }
            })
            .catch(function () {})
        }
        tick()
        var stop = ctx.timer.interval(tick, 1500)
        return function () {
          alive = false
          if (typeof stop === 'function') stop()
        }
      }, [])
      return data[0]
    }

    // (1) Transient toast — appears briefly whenever the counter increases.
    function ToastView(ctx) {
      var data = useResumed(ctx)
      var toast = react.useState(null)
      var setToast = toast[1]
      var seen = react.useRef(0)
      react.useEffect(function () {
        if (data && data.count > seen.current) {
          seen.current = data.count
          setToast({ seq: data.count, provider: data.lastProvider, at: data.lastAt })
          var t = setTimeout(function () {
            setToast(null)
          }, 6000)
          return function () {
            clearTimeout(t)
          }
        }
      }, [data])
      if (!toast[0]) return null
      return react.createElement(
        Card,
        null,
        react.createElement(Header, {
          title: '⚠️ 流式断流已自动续写',
          right: '×' + toast[0].seq
        }),
        react.createElement(
          'div',
          { style: { padding: '0 12px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #555)' } },
          '缺失 finish_reason 已容忍为正常完成，未从零重试（provider: ' +
            (toast[0].provider || '未知') +
            '）'
        )
      )
    }

    // (2) Inline notice inside the message list (after each completed turn).
    function TailNotice(ctx) {
      var data = useResumed(ctx)
      if (!data || data.count === 0) return null
      return react.createElement(
        Card,
        null,
        react.createElement(Header, {
          title: '⚠️ 流式断流已自动续写',
          right: '累计 ×' + data.count
        }),
        react.createElement(
          'div',
          { style: { padding: '0 12px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #555)' } },
          '最近一次：provider ' +
            (data.lastProvider || '未知') +
            (data.lastAt ? '，' + new Date(data.lastAt).toLocaleTimeString() : '')
        )
      )
    }

    function apply(ctx, host) {
      var slots = ctx.get('slots')
      if (slots === undefined) return

      // Transient alert toast (floating layer, additive).
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'resume-stream-toast' },
          function () {
            return ToastView(ctx)
          }
        )
      })

      // Persistent inline notice in the message list (after every completed turn).
      slots.inject('conversation.chat.turnTail', function () {
        return slots.register(
          {
            name: 'conversation.chat.turnTail',
            select: function (owner) {
              return cache.count > 0 ? owner : null
            }
          },
          function () {
            return TailNotice(ctx)
          }
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'timer']
    return module.exports
  }
})
