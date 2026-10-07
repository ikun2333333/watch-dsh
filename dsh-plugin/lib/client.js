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
			// The pairing panel. Bordered and inset rather than floating: it sits in
			// the composer dock, where a positioned overlay would be clipped by
			// whichever ancestor owns the scrolling.
			".dshwd_panel{margin-top:6px;border:1px solid var(--dsw-alias-separator-primary);",
			"border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:7px}",
			".dshwd_h{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
			".dshwd_note{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}",
			".dshwd_devices{display:flex;flex-wrap:wrap;gap:5px}",
			".dshwd_dev{font:inherit;font-size:11px;font-family:var(--dsw-font-mono);cursor:pointer;",
			"border:1px solid var(--dsw-alias-separator-primary);border-radius:6px;padding:3px 8px;",
			"background:0 0;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;",
			"text-overflow:ellipsis;white-space:nowrap}",
			".dshwd_dev:hover:not(:disabled){background:var(--dsw-alias-fill-l2)}",
			".dshwd_devOn{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}",
			".dshwd_inrow{display:flex;gap:5px;align-items:center}",
			".dshwd_input{flex:1;min-width:0;font:inherit;font-size:11px;font-family:var(--dsw-font-mono);",
			"padding:3px 7px;border-radius:6px;border:1px solid var(--dsw-alias-separator-primary);",
			"background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary)}",
			".dshwd_go{font:inherit;font-size:11px;font-weight:600;cursor:pointer;border:0;",
			"border-radius:6px;padding:4px 12px;background:var(--dsw-alias-button-primary-fill);",
			"color:var(--dsw-alias-button-primary-label)}",
			".dshwd_go:disabled{opacity:.5;cursor:default}",
			".dshwd_result{font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-word}",
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

			return react.createElement(
				"div",
				null,
				react.createElement(
					"div",
					{ className: "dshwd_row" },
					react.createElement("span", { className: "dshwd_dot " + tone }),
					react.createElement(
						"span",
						{ className: "dshwd_label", title: status.detail },
						busy ? "switching relay..." : status.detail ?? "watch",
					),
					react.createElement(
						"span",
						{ className: "dshwd_modes" },
						react.createElement(
							"button",
							{
								className: "dshwd_mode" + (open ? " dshwd_modeOn" : ""),
								onClick: () => setOpen(!open),
								title: "Pair a watch over adb",
							},
							"Pair",
						),
						button("lan", "LAN", "Use the relay on this network"),
						button("public", "Public", "Use the public relay"),
					),
				),
				open ? react.createElement(PairPanel, { onClose: () => setOpen(false) }) : null,
			)
		}

		/**
		 * Pair a watch, over adb, from here.
		 *
		 * Three steps in the order they have to happen: attach the watch (it may
		 * already be attached), choose what the config should point at, pair. The
		 * device list is the host's, because adb runs there - a browser cannot reach
		 * a watch and has no business trying.
		 */
		function PairPanel(props) {
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
				{ className: "dshwd_panel" },
				react.createElement("div", { className: "dshwd_h" }, "Pair a watch"),

				react.createElement(
					"div",
					{ className: "dshwd_note" },
					ready.length > 0
						? "Choose the watch to pair."
						: "No watch is attached. On the watch: Settings > About watch > Software, tap " +
							'"Software version" five times, then Developer options > Wireless debugging, ' +
							"and enter the address it shows.",
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
