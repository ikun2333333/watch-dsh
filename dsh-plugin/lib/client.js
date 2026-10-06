/**
 * dsh-watch-dsh, browser half.
 *
 * Shows the watch link's status in the composer bar.
 *
 * ## Where the data comes from
 *
 * A status file the host half writes, fetched by URL. Not an HTTP route: the
 * desktop app serves the UI over a custom `dsh-app://` protocol and has no web
 * server, so a route would only work in the browser shell. A file read works in
 * both.
 *
 * ## Why it renders nothing when it cannot read
 *
 * This plugin once stopped DSH from starting, by leaving the conversation UI
 * waiting on a slot occupant that never became ready. The lesson taken from that
 * is here: if the status cannot be read, the component returns null. A status
 * line that is absent is a small loss; a composer bar that blocks is not.
 */
window.__ModuleLoader__.load({
	id: "dsh-watch-dsh",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		let react = require("react")

		/** Poll cadence. A status light, not a progress bar. */
		const POLL_MS = 3000

		/**
		 * Candidate URLs for the status file, most likely first.
		 *
		 * The host writes into the workspace's own state directory, and the shell's
		 * URL does not map onto the filesystem in a way worth relying on, so several
		 * shapes are tried and a miss is not an error - it means the bar stays
		 * absent, which is the safe outcome.
		 *
		 * `__DSH_WATCH_STATUS__` is honoured first so the host can name the exact
		 * URL through an index injection rather than leaving it to be guessed.
		 */
		function candidateUrls() {
			const configured = globalThis.__DSH_WATCH_STATUS__
			const list = configured ? [String(configured)] : []
			return list.concat([
				"/watch-dsh/status.json",
				"/.state/dsh-status.json",
				"./.state/dsh-status.json",
			])
		}

		async function readStatus() {
			for (const url of candidateUrls()) {
				try {
					const response = await fetch(url, { credentials: "omit", cache: "no-store" })
					if (!response.ok) continue
					return await response.json()
				} catch {
					// Next shape; the list is short and ordered by likelihood.
				}
			}
			return null
		}

		const CSS = [
			".dshwd-row{display:flex;align-items:center;gap:8px;min-height:24px;padding:0 2px;",
			"font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dshwd-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
			".dshwd-ok{background:#2ea043}",
			".dshwd-warn{background:#d29922}",
			".dshwd-bad{background:#f85149}",
			".dshwd-label{font-family:var(--dsw-font-mono);white-space:nowrap;overflow:hidden;",
			"text-overflow:ellipsis;min-width:0;flex:1}",
		].join("")

		function ensureCss() {
			if (typeof document === "undefined") return
			const id = "dsh-watch-dsh/status.css"
			if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
			const tag = document.createElement("style")
			tag.dataset.plugin = "dsh-watch-dsh"
			tag.dataset.pluginCss = id
			tag.textContent = CSS
			document.head.appendChild(tag)
		}

		/** The status line. */
		function WatchBar() {
			const [status, setStatus] = react.useState(null)
			const [seen, setSeen] = react.useState(false)

			react.useEffect(() => {
				let live = true
				ensureCss()

				const tick = async () => {
					const next = await readStatus()
					if (!live) return
					setStatus(next)
					setSeen(true)
				}

				tick()
				const timer = setInterval(tick, POLL_MS)
				return () => {
					live = false
					clearInterval(timer)
				}
			}, [])

			// Nothing readable: contribute nothing. See the file comment.
			if (!seen || status === null) return null

			const online = status.ok === true
			return react.createElement(
				"div",
				{ className: "dshwd-row" },
				react.createElement("span", { className: "dshwd-dot " + (online ? "dshwd-ok" : "dshwd-warn") }),
				react.createElement(
					"span",
					{ className: "dshwd-label", title: status.detail },
					status.detail ?? "watch",
				),
			)
		}

		const inject = ["slots"]

		function apply(ctx) {
			// Declared, so present; guarded anyway so that a shell without it loses
			// the bar rather than the plugin.
			if (typeof ctx?.slots?.inject !== "function") return
			ctx.slots.inject("conversation.composer.bar", () =>
				ctx.slots.register(
					{ name: "conversation.composer.bar", id: "watch-dsh-bar", order: 90 },
					WatchBar,
				),
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
