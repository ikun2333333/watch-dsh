/**
 * dsh-watch-dsh, browser half.
 *
 * Contributes the watch link's status and mode switch to the composer bar. It
 * reads from the host half over plain HTTP rather than the client RPC layer:
 * `ctx.webServer` already serves routes on the GUI's own origin, so a fetch needs
 * no generated contract and stays readable in the network tab.
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

		/** Poll cadence. A status light, not a progress bar. */
		const POLL_MS = 3000

		async function getStatus() {
			try {
				const response = await fetch(BASE + "/status", { credentials: "same-origin" })
				if (!response.ok) return null
				return await response.json()
			} catch {
				return null
			}
		}

		async function setMode(mode) {
			try {
				const response = await fetch(BASE + "/mode", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode }),
				})
				return await response.json()
			} catch (error) {
				return { ok: false, error: String(error) }
			}
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
			".dshwd-modes{display:flex;gap:2px;flex:none}",
			".dshwd-mode{font:inherit;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;",
			"border-radius:5px;padding:2px 7px;cursor:pointer;line-height:16px}",
			".dshwd-mode:hover:not(:disabled){color:var(--dsw-alias-label-secondary);",
			"background:var(--dsw-alias-fill-l2)}",
			".dshwd-mode:disabled{cursor:default}",
			".dshwd-modeOn{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2)}",
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
		 * Status and the mode switch, for the composer bar.
		 *
		 * The mode is a manual switch rather than something inferred from the
		 * network, because inferring it was tried and does not work: broadcast only
		 * reaches the local network, and routers that drop traffic between wireless
		 * clients are common enough that this project measured one. A decision that
		 * depends on a packet the network may discard is a decision that silently
		 * goes the wrong way, so the user says where they are.
		 */
		function WatchBar() {
			const [status, setStatus] = react.useState(null)
			const [seen, setSeen] = react.useState(false)
			const [busy, setBusy] = react.useState(false)

			react.useEffect(() => {
				let live = true
				ensureCss()

				const tick = async () => {
					const next = await getStatus()
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

			const mode = status?.mode ?? "lan"
			const online = status !== null && status.ok === true
			const tone = !seen ? "" : status === null ? "dshwd-bad" : online ? "dshwd-ok" : "dshwd-warn"

			const label = !seen
				? "watch: connecting"
				: status === null
					? "watch: plugin not serving"
					: status.detail

			const press = async (next) => {
				if (busy || next === mode) return
				setBusy(true)
				const result = await setMode(next)
				if (!result.ok && result.error) {
					// Reported through the status line on the next poll, so the bar
					// never silently ignores a refused switch.
					setStatus((prev) => (prev ? { ...prev, detail: result.error } : prev))
				}
				setBusy(false)
			}

			const button = (value, text) =>
				react.createElement(
					"button",
					{
						className: "dshwd-mode" + (mode === value ? " dshwd-modeOn" : ""),
						onClick: () => press(value),
						disabled: busy || mode === value,
						title: value === "lan" ? "Use the relay on this network" : "Use the public relay",
					},
					text,
				)

			return react.createElement(
				"div",
				{ className: "dshwd-row" },
				react.createElement("span", { className: "dshwd-dot " + tone }),
				react.createElement("span", { className: "dshwd-label", title: label }, label),
				react.createElement(
					"span",
					{ className: "dshwd-modes" },
					button("lan", "LAN"),
					button("public", "Public"),
				),
			)
		}

		const inject = ["slots"]

		function apply(ctx) {
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
