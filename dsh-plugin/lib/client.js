/**
 * dsh-watch-dsh, browser half.
 *
 * ## Why this registers nothing
 *
 * An earlier version contributed a status line to `conversation.composer.bar`. It
 * stopped DSH from starting, three times, with this in the desktop app's crash log:
 *
 *   Error: web boot: 8 entries did not activate
 *   @deepseek-ai/dsh-client-ui-conversation: failed
 *   @deepseek-ai/dsh-client-ui-chat: pending (waiting for service: uiConversation)
 *   ... six more pending on uiConversation
 *
 * A plugin that contributes to a slot is *waited on* by whatever renders that
 * slot. When this one could not complete, the conversation plugin could not
 * either, and everything that needs `uiConversation` fell over behind it. The
 * report named the conversation plugin, so the cause sat three steps away from
 * the symptom.
 *
 * A status line is not worth that, and nothing here is. This file now registers no
 * slot, contributes no component, and cannot be waited on for anything. The host
 * half - the relay, the bridge, the mode switch, the status endpoint - does not
 * depend on it and keeps working.
 *
 * ## What replaces it
 *
 * The status is served over HTTP on loopback (status-server.js) and written to
 * `.state/dsh-status.json`, so it can be read with a browser tab, `curl`, or the
 * file itself. That is how it should have been surfaced from the start, rather
 * than by reaching into someone else's UI.
 */
window.__ModuleLoader__.load({
	id: "dsh-watch-dsh",
	factory: () => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		/** Nothing to wait for. The empty list is the point, not an omission. */
		const inject = []

		/** No slots, no components, no effects, nothing to fail. */
		function apply() {}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
