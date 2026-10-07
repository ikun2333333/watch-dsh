/**
 * dsh-watch-dsh, browser half.
 *
 * Shows the watch link's status under the composer, and lets the user switch
 * between the LAN and public relays.
 *
 * ## What this follows, and why
 *
 * Three earlier versions stopped DSH from starting. The crash log always named the
 * conversation plugin:
 *
 *   Error: web boot: 8 entries did not activate
 *   @deepseek-ai/dsh-client-ui-conversation: failed
 *   @deepseek-ai/dsh-client-ui-chat: pending (waiting for service: uiConversation)
 *
 * It was the victim, not the cause: a plugin that registers into a slot is waited
 * on by whatever renders that slot, so a contribution that cannot complete takes
 * the renderer down with it.
 *
 * This version follows `dsh-api-dashboard` (MIT), a working third-party plugin for
 * the same shell, on the three points where this one differed from it:
 *
 *   - it registers into `conversation.composer.dock`, not `...composer.bar`;
 *   - its `dsh.client.inject` names client plugins, not host services, so the
 *     shell holds it back until the renderer it depends on is present rather than
 *     leaving it pending forever;
 *   - it is installed with a `node_modules` symlink beside the sources, which the
 *     host resolves peer dependencies through.
 *
 * ## Still guarded
 *
 * The component returns null when it has no status to show, so a fetch that never
 * succeeds leaves the composer untouched rather than an empty row in it.
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

		/** Where the host half listens. It prefers the first and scans upward. */
		const STATUS_PORTS = [8799, 8800, 8801, 8802, 8803, 8804, 8805, 8806]

		function candidateUrls() {
			const configured = globalThis.__DSH_WATCH_STATUS__
			if (configured) return [String(configured)]
			return STATUS_PORTS.map((port) => "http://127.0.0.1:" + port + "/")
		}

		async function readStatus() {
			for (const url of candidateUrls()) {
				try {
					const response = await fetch(url, { credentials: "omit", cache: "no-store" })
					if (!response.ok) continue
					return await response.json()
				} catch {
					// Try the next port. On the desktop shell the page is served from a
					// custom scheme, so a loopback fetch is cross-origin and depends on
					// the host half sending the header it does.
				}
			}
			return null
		}

		const CSS = [
			".dshwd_row{display:flex;align-items:center;gap:8px;min-height:24px;padding:0 2px;",
			"font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dshwd_dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
			".dshwd_ok{background:#2ea043}",
			".dshwd_warn{background:#d29922}",
			".dshwd_label{font-family:var(--dsw-font-mono);white-space:nowrap;overflow:hidden;",
			"text-overflow:ellipsis;min-width:0;flex:1}",
			".dshwd_modes{display:flex;gap:2px;flex:none}",
			".dshwd_mode{font:inherit;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;",
			"border-radius:5px;padding:2px 7px;cursor:pointer;line-height:16px}",
			".dshwd_mode:hover:not(:disabled){color:var(--dsw-alias-label-secondary);",
			"background:var(--dsw-alias-fill-l2)}",
			".dshwd_mode:disabled{cursor:default}",
			".dshwd_modeOn{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2)}",
			// The status text is the way in to pairing. It looks like a label until
			// hovered, because the bar's job is to report, and a row of buttons in the
			// composer is noise.
			".dshwd_open{background:0 0;border:0;padding:0;font:inherit;text-align:left;cursor:pointer;",
			"color:inherit;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dshwd_open:hover{color:var(--dsw-alias-label-secondary)}",
			// Detached from the composer, following dsh-api-dashboard's drawer.
			//
			// Fixed rather than inline, and this is the whole point: the bar lives in
			// the composer dock, where any ancestor with a transform or an overflow
			// clips a panel that tries to grow out of it. The dashboard hit this too
			// and moved its surface out of the flow, so this does the same - a sheet
			// pinned to the bottom, above everything.
			".dshwd_scrim{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.35);",
			"animation:dshwd-fade .15s ease-out;",
			// A guard, not decoration: the mobile shell opens its sidebar on a stroke
			// starting in the left half of the screen, and it listens in the capture
			// phase, so no plugin can intercept it. It does step aside for a genuinely
			// horizontally scrollable ancestor, so a 2px invisible overflow here makes
			// the whole sheet fall under that rule. The scrim is fixed, so scrolling it
			// moves nothing.
			"overflow-x:auto;overflow-y:hidden;scrollbar-width:none}",
			".dshwd_scrim::-webkit-scrollbar{display:none}",
			".dshwd_sheet{position:fixed;left:0;right:0;bottom:0;z-index:99999;",
			"max-height:min(80vh,calc(100vh - 24px));background:var(--dsw-alias-bg-primary);",
			"border-radius:18px 18px 0 0;box-shadow:0 -8px 32px rgba(0,0,0,.18);",
			"display:flex;flex-direction:column;overflow:hidden;",
			"animation:dshwd-rise .22s cubic-bezier(.16,1,.3,1)}",
			"@media (min-width:561px){.dshwd_sheet{width:min(560px,calc(100vw - 48px));margin:0 auto;bottom:12px;",
			"border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.22)}}",
			"@keyframes dshwd-rise{from{transform:translateY(100%)}to{transform:translateY(0)}}",
			"@keyframes dshwd-fade{from{opacity:0}to{opacity:1}}",
			".dshwd_grip{flex:none;padding:7px 0 3px;display:flex;justify-content:center;cursor:grab}",
			".dshwd_grip span{width:34px;height:4px;border-radius:2px;background:var(--dsw-alias-separator-primary)}",
			".dshwd_head{flex:none;display:flex;align-items:center;gap:8px;padding:2px 14px 8px;",
			"font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".dshwd_head .dshwd_x{margin-left:auto;font:inherit;font-size:12px;font-weight:400;cursor:pointer;",
			"border:0;background:0 0;color:var(--dsw-alias-label-tertiary);padding:2px 6px;border-radius:5px}",
			".dshwd_head .dshwd_x:hover{background:var(--dsw-alias-fill-l2)}",
			".dshwd_body{overflow-y:auto;padding:0 14px 14px;display:flex;flex-direction:column;gap:9px}",
			".dshwd_h{font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;",
			"color:var(--dsw-alias-label-tertiary)}",
			".dshwd_note{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}",
			".dshwd_devices{display:flex;flex-wrap:wrap;gap:6px}",
			".dshwd_dev{font:inherit;font-size:12px;font-family:var(--dsw-font-mono);cursor:pointer;",
			"border:1px solid var(--dsw-alias-separator-primary);border-radius:7px;padding:5px 10px;",
			"background:0 0;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;",
			"text-overflow:ellipsis;white-space:nowrap}",
			".dshwd_dev:hover:not(:disabled){background:var(--dsw-alias-fill-l2)}",
			".dshwd_devOn{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}",
			".dshwd_inrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
			".dshwd_input{flex:1;min-width:130px;font:inherit;font-size:12px;font-family:var(--dsw-font-mono);",
			"padding:5px 9px;border-radius:7px;border:1px solid var(--dsw-alias-separator-primary);",
			"background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary)}",
			".dshwd_go{font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:0;",
			"border-radius:7px;padding:6px 14px;background:var(--dsw-alias-button-primary-fill);",
			"color:var(--dsw-alias-button-primary-label)}",
			".dshwd_go:disabled{opacity:.5;cursor:default}",
			".dshwd_result{font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word;",
			"border-radius:7px;padding:7px 9px;background:var(--dsw-alias-fill-l1)}",
			".dshwd_good{color:var(--dsw-alias-state-success-primary)}",
			".dshwd_bad{color:var(--dsw-alias-state-error-primary)}",
		].join("")

		/**
		 * Send one command to the host half.
		 *
		 * Commands are POSTs so a prefetch cannot perform one, and the host half
		 * answers a refusal with 400 and a reason rather than a success.
		 */
		async function sendCommand(route, body) {
			for (const url of candidateUrls()) {
				const base = url.endsWith("/") ? url.slice(0, -1) : url
				try {
					const response = await fetch(base + route, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body ?? {}),
					})
					if (response.ok || response.status === 400 || response.status === 404) {
						return await response.json()
					}
				} catch {
					// Next port.
				}
			}
			return null
		}

		function sendMode(mode) {
			return sendCommand("/mode", { mode })
		}

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

		function WatchStatus() {
			const [status, setStatus] = react.useState(null)
			const [seen, setSeen] = react.useState(false)
			const [busy, setBusy] = react.useState(false)
			// The pairing panel is opened deliberately: it is a task, not decoration,
			// so it does not take up space in the composer unless it is being done.
			const [open, setOpen] = react.useState(false)

			/**
			 * Switch relays, and report a refusal rather than swallowing it.
			 *
			 * The host half restarts the bridge, so this is not instant; `busy` covers
			 * the gap so a second press cannot queue another switch behind the first.
			 */
			const press = async (next) => {
				if (busy) return
				setBusy(true)
				try {
					const result = await sendMode(next)
					if (result?.status) setStatus(result.status)
					else if (result?.error) {
						// Shown through the label, so a refused switch is visible instead
						// of looking like a button that did nothing.
						setStatus((prev) => (prev ? { ...prev, detail: result.error } : prev))
					}
				} finally {
					setBusy(false)
				}
			}

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

			// Nothing readable: contribute nothing at all. An absent status line is a
			// small loss; a composer that waits on this is not.
			if (!seen || status === null) return null

			const mode = status.mode === "public" ? "public" : "lan"
			const tone = status.ok === true ? "dshwd_ok" : "dshwd_warn"

			// The switch is manual rather than inferred, because inferring it was
			// tried in this project and does not work: broadcast only reaches the local
			// network, and routers that drop traffic between wireless clients are
			// common enough that one was measured on this network. A decision that
			// depends on a packet the network may discard is a decision that silently
			// goes the wrong way, so the user says where they are.
			const button = (value, text, title) =>
				react.createElement(
					"button",
					{
						className: "dshwd_mode" + (mode === value ? " dshwd_modeOn" : ""),
						onClick: () => press(value),
						disabled: busy || mode === value,
						title,
					},
					text,
				)

			// The bar reports and nothing else. Pairing is reached by pressing the
			// status itself, which is where a reader's eye already is, and it opens a
			// sheet of its own rather than growing inside the composer - the
			// dashboard keeps its surfaces out of the bar for the same reason.
			return react.createElement(
				"div",
				null,
				react.createElement(
					"div",
					{ className: "dshwd_row" },
					react.createElement("span", { className: "dshwd_dot " + tone }),
					react.createElement(
						"button",
						{
							className: "dshwd_open",
							onClick: () => setOpen(true),
							title: "Pair a watch over adb",
						},
						busy ? "switching relay..." : status.detail ?? "watch",
					),
					react.createElement(
						"span",
						{ className: "dshwd_modes" },
						button("lan", "LAN", "Use the relay on this network"),
						button("public", "Public", "Use the public relay"),
					),
				),
				open ? react.createElement(PairSheet, { onClose: () => setOpen(false) }) : null,
			)
		}

		/**
		 * Pair a watch, over adb, from here.
		 *
		 * A sheet pinned to the bottom of the viewport, following dsh-api-dashboard's
		 * drawer: fixed positioning, a scrim behind it, and z-index above the shell's
		 * own overlays. Inline would have been simpler and does not work - the
		 * composer dock clips anything that tries to grow out of it.
		 *
		 * Three steps in the order they have to happen: attach the watch (it may
		 * already be attached), choose what the config should point at, pair. The
		 * device list comes from the host, because adb runs there.
		 */
		function PairSheet(props) {
			const [devices, setDevices] = react.useState([])
			const [serial, setSerial] = react.useState("")
			const [address, setAddress] = react.useState("")
			const [mode, setMode] = react.useState("both")
			const [busy, setBusy] = react.useState("")
			const [result, setResult] = react.useState(null)

			const refresh = react.useCallback(async () => {
				setBusy("devices")
				try {
					const answer = await sendCommand("/devices", {})
					setDevices(answer?.devices ?? [])
					setSerial((current) => {
						const usable = (answer?.usable ?? [])
						if (usable.includes(current)) return current
						return usable[0] ?? ""
					})
				} finally {
					setBusy("")
				}
			}, [])

			react.useEffect(() => {
				void refresh()
			}, [refresh])

			// Escape closes it, like any other sheet. Listening on the document rather
			// than the sheet means it works before anything inside has been focused.
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") props.onClose()
				}
				document.addEventListener("keydown", onKey)
				return () => document.removeEventListener("keydown", onKey)
			}, [props])

			const attach = async () => {
				if (address.trim() === "") return
				setBusy("connect")
				setResult(null)
				try {
					const answer = await sendCommand("/connect", { address })
					if (answer?.ok === false) setResult({ ok: false, text: answer.error })
					else setResult({ ok: true, text: "attached" })
				} finally {
					setBusy("")
					void refresh()
				}
			}

			const pair = async () => {
				setBusy("pair")
				setResult(null)
				try {
					const answer = await sendCommand("/pair", { serial, mode })
					if (answer === null) {
						setResult({ ok: false, text: "the host half did not answer" })
					} else if (answer.ok === true) {
						setResult({
							ok: true,
							text: `Paired - ${answer.detail}\nThe watch will reach the PC by ${answer.modeDescription}.`,
						})
					} else {
						setResult({
							ok: false,
							text: `${answer.error ?? "pairing failed"}\n${answer.detail ?? ""}`.trim(),
						})
					}
				} finally {
					setBusy("")
					// The pairing restarts the watch app, so its arrival is worth a
					// status refresh rather than waiting for the next poll.
					void refresh()
				}
			}

			// Only `device` can be paired against; the others are shown so the reason
			// is visible instead of the watch simply not appearing.
			const ready = devices.filter((entry) => entry.state === "device")
			const other = devices.filter((entry) => entry.state !== "device")

			return react.createElement(
				"div",
				null,
				// The scrim carries a 2px invisible horizontal overflow; see the CSS
				// comment. It is also the click target for dismissing.
				react.createElement("div", { className: "dshwd_scrim", onClick: () => props.onClose() }),
				react.createElement(
					"div",
					{ className: "dshwd_sheet", role: "dialog", "aria-label": "Pair a watch" },
					react.createElement(
						"div",
						{ className: "dshwd_grip", onClick: () => props.onClose() },
						react.createElement("span", null),
					),
					react.createElement(
						"div",
						{ className: "dshwd_head" },
						"Pair a watch",
						react.createElement(
							"button",
							{ className: "dshwd_x", onClick: () => props.onClose(), title: "Close" },
							"Close",
						),
					),
					react.createElement(
						"div",
						{ className: "dshwd_body" },
						react.createElement("div", { className: "dshwd_h" }, "Watch"),
						react.createElement(
							"div",
							{ className: "dshwd_note" },
							ready.length > 0
								? "Choose the watch to pair. Its connection settings are replaced."
								: "No watch is attached. On the watch: Settings > About watch > Software, " +
									'tap "Software version" five times, then Developer options > Wireless ' +
									"debugging, and enter the address it shows.",
						),

				ready.length > 0
					? react.createElement(
							"div",
							{ className: "dshwd_devices" },
							ready.map((entry) =>
								react.createElement(
									"button",
									{
										key: entry.serial,
										className: "dshwd_dev" + (serial === entry.serial ? " dshwd_devOn" : ""),
										onClick: () => setSerial(entry.serial),
									},
									entry.serial,
								),
							),
						)
					: react.createElement(
							"div",
							{ className: "dshwd_inrow" },
							react.createElement("input", {
								className: "dshwd_input",
								value: address,
								placeholder: "192.168.1.23:37000",
								onChange: (event) => setAddress(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter") void attach()
								},
							}),
							react.createElement(
								"button",
								{
									className: "dshwd_go",
									onClick: () => void attach(),
									disabled: busy !== "" || address.trim() === "",
								},
								busy === "connect" ? "..." : "Attach",
							),
						),

				other.length > 0
					? react.createElement(
							"div",
							{ className: "dshwd_note" },
							other.map((entry) => `${entry.serial} (${entry.state})`).join(", "),
						)
					: null,

				react.createElement(
					"div",
					{ className: "dshwd_inrow" },
					react.createElement("span", { className: "dshwd_note" }, "Point it at"),
					react.createElement(
						"span",
						{ className: "dshwd_modes" },
						["both", "lan", "public"].map((value) =>
							react.createElement(
								"button",
								{
									key: value,
									className: "dshwd_mode" + (mode === value ? " dshwd_modeOn" : ""),
									onClick: () => setMode(value),
									title:
										value === "both"
											? "The local relay at home, the public one away - no re-pairing when you leave"
											: value === "lan"
												? "Only the relay on this network"
												: "Only the public relay",
								},
								value === "both" ? "Both" : value === "lan" ? "LAN" : "Public",
							),
						),
					),
				),

				react.createElement(
					"div",
					{ className: "dshwd_inrow" },
					react.createElement(
						"button",
						{
							className: "dshwd_go",
							onClick: () => void pair(),
							disabled: busy !== "" || serial === "",
						},
						busy === "pair" ? "Pairing..." : "Pair",
					),
					react.createElement(
						"button",
						{ className: "dshwd_mode", onClick: () => void refresh(), disabled: busy !== "" },
						"Refresh",
					),
					busy === "pair"
						? react.createElement(
								"span",
								{ className: "dshwd_note" },
								"writing the config, restarting the app, checking the handshake...",
							)
						: null,
				),

						result !== null
							? react.createElement(
									"div",
									{ className: "dshwd_result " + (result.ok ? "dshwd_good" : "dshwd_bad") },
									result.text,
								)
							: null,
					),
				),
			)
		}

		/**
		 * The Cordis services this half needs, by *service* name.
		 *
		 * `slots` and nothing else: registering into a slot is the only thing this
		 * does.
		 *
		 * This list previously held package names, which was the bug that stopped
		 * DSH from starting - the shell waited for a service called
		 * `@deepseek-ai/dsh-client-locale`, which does not exist and never would, so
		 * the plugin stayed pending forever. The two are different lists with
		 * different vocabularies, and the shipped plugins show it plainly:
		 * `dsh-client-resources` has `const inject = ["slots"]` in its code and
		 * `["@deepseek-ai/dsh-client-ui-renderer"]` in its manifest. Service names
		 * here; package names there.
		 */
		const inject = ["slots"]

		function apply(ctx) {
			if (typeof ctx?.slots?.inject !== "function") return
			// Deferred registration, which is required rather than stylistic:
			// `conversation.composer.dock` is declared by an entry inside
			// `conversation.composer.bar` and only exists once that entry mounts, so
			// registering before it is live would target a slot that is not there.
			//
			// The id is unique and the order is the default band, which is what keeps
			// this additive: a list slot's uniqueness is the (id, priority) pair, so a
			// unique id cannot collide with the shipped occupant (`stats`).
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "watch-dsh-status",
						order: 90,
						label: "Watch link",
					},
					WatchStatus,
				),
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
