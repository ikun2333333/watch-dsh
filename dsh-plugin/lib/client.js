/**
 * dsh-watch-dsh, browser half.
 *
 * Contributes the watch link's status to the composer bar and opens the pairing
 * panel. It reads from the host half over plain HTTP rather than the client RPC
 * layer: `ctx.webServer` already serves routes on the GUI's own origin, so a
 * fetch needs no generated contract and stays readable in the network tab.
 *
 * The bundle format is the one the client module loader expects - a
 * `window.__ModuleLoader__.load` call rather than a plain ES module - because
 * that is how the shell discovers and executes browser plugins.
 */
window.__ModuleLoader__.load({
	id: "dsh-watch-dsh",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		let react = require("react")

		const BASE = "/watch-dsh"

		/** Poll cadence. Slow: this is a status light, not a progress bar. */
		const POLL_MS = 3000

		/**
		 * Read the host half's status.
		 *
		 * @returns the status object, or null when the host half is not serving.
		 */
		async function fetchStatus() {
			try {
				const response = await fetch(BASE + "/status", { credentials: "same-origin" })
				if (!response.ok) return null
				return await response.json()
			} catch {
				return null
			}
		}

		const CSS = [
			".dshwd-row{display:flex;align-items:center;gap:6px;min-height:24px;padding:0 2px;",
			"font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:default}",
			".dshwd-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
			".dshwd-ok{background:#2ea043}",
			".dshwd-warn{background:#d29922}",
			".dshwd-bad{background:#f85149}",
			".dshwd-label{font-family:var(--dsw-font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
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

		/**
		 * The status line for the composer bar.
		 *
		 * Reports the three things that can independently be wrong - the relay, the
		 * bridge, and the watch itself - rather than one combined light, because
		 * they fail for different reasons and are fixed in different places.
		 */
		function WatchStatus() {
			const [status, setStatus] = react.useState(null)
			const [seen, setSeen] = react.useState(false)

			react.useEffect(() => {
				let live = true
				ensureCss()

				const tick = async () => {
					const next = await fetchStatus()
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

			const tone = !seen ? "" : status === null ? "dshwd-bad" : status.ok ? "dshwd-ok" : "dshwd-warn"
			const label = !seen
				? "watch: connecting"
				: status === null
					? "watch: plugin not serving"
					: "watch: " + (status.detail ?? "ready")

			return react.createElement(
				"div",
				{ className: "dshwd-row", title: label },
				react.createElement("span", { className: "dshwd-dot " + tone }),
				react.createElement("span", { className: "dshwd-label" }, label),
			)
		}

		const inject = ["slots"]

		function apply(ctx) {
			ctx.slots.inject("conversation.composer.bar", () =>
				ctx.slots.register({ name: "conversation.composer.bar", id: "watch-dsh-status", order: 90 }, WatchStatus),
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
