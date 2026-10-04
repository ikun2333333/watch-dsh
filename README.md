# watch-dsh

Control a PC's [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from a
Samsung Galaxy Watch 6. You speak a request into the watch, the agent runs on the PC, and the
reply streams back to your wrist. Approvals — the "may I run this tool?" prompts — arrive as a
dialog you can answer from the watch, so the agent keeps working while you are away from the desk.

```
  Galaxy Watch 6                relay (optional)              PC
  ┌──────────────┐              ┌──────────────┐        ┌──────────────────┐
  │  watch app   │──── wss ────▶│ routes opaque│◀───────│ bridge           │
  │  Kotlin +    │              │ sealed frames│  wss   │  owns the DSH    │
  │  Compose     │◀─────────────│ holds no key │───────▶│  session cookie  │
  └──────────────┘              └──────────────┘        └────────┬─────────┘
                                                                 │ loopback
                                                        ┌────────▼─────────┐
                                                        │ dsh web (3080)   │
                                                        └──────────────────┘
```

## Why there is a bridge at all

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0` on purpose:

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
it would expose remote code execution to the network
```

Its browser authentication is also an `HttpOnly`, authority-bound signed cookie, which a watch
cannot present. So instead of weakening the Harness, this project adds a bridge that:

1. lives on the PC and holds the browser-session credential locally,
2. speaks the Harness's own Remote protocol over loopback,
3. reduces the Harness's verbose event journal into watch-sized frames,
4. exposes only that reduced surface, end-to-end encrypted, to the watch.

Nothing in the Harness is patched, and its network posture is unchanged.

## What works today

Verified end to end on this machine (`11/11` checks, see [Verification](#verification)):

| Capability | State |
|---|---|
| Send a request, watch the reply stream in | works |
| Session list, open an existing session, start a new one | works |
| Interrupt a running turn | works |
| Answer an approval from the watch | works |
| Voice input (system dictation) | works |
| Reasoning summarised rather than streamed | by design — a watch has no room for a chain of thought |
| Push notification when a background turn finishes | not yet implemented |
| Run over the LAN (watch and PC on the same Wi-Fi) | works — `tools\lan-test.ps1`, verified over `192.168.1.50` |
| Run over mobile data | needs a relay you deploy — see [Away from home](#away-from-home) |

## Layout

```
packages/dsh-bridge/       PC side
  src/dsh-client.mjs       DSH protocol client: mints the browser cookie, RPC + streams
  src/descriptors.mjs      reads the exact argument names of every mounted endpoint
  src/protocol.mjs         the wire format, and end-to-end sealing
  src/bridge.mjs           Harness events -> watch frames; approvals; session tracking
  src/main.mjs             entry point: dials the relay, prints the pairing values
  src/relay-core.mjs       transport-agnostic relay routing (shared by both relays)
  src/relay.mjs            relay for a host you control
  src/relay-worker.mjs     relay for Cloudflare Workers
  test/e2e.mjs             drives the whole chain the way the watch will
packages/watch-app/        Wear OS app (Kotlin, Compose for Wear OS)
docs/protocol.md           normative wire specification
tools/                     toolchain bootstrap and build scripts
  lan-test.ps1             one-command LAN setup: relay + bridge, ready for the watch
  gen-secret.mjs           CSPRNG secret generation (Get-Random is not one)
```

## Quick start

### 1. Make sure the Harness is running

```powershell
dsh web                       # serves http://127.0.0.1:3080
```

### 2. Start the relay and the bridge

Two modes. **Start with the LAN one** — it needs no account and no tunnel, so it is
the fastest way to prove the whole chain works, and it stays the lower-latency path
afterwards.

#### Pair the watch (the whole flow, one command)

```powershell
.\tools\pair-watch.ps1
```

That starts the relay and bridge if they are not already up, writes the watch's config,
pushes it over `adb`, restarts the app, and reads back what the watch recorded:

```
[1] a relay is already listening on 8787 (started by an earlier run)
[2] writing the watch config
[3] using device adb-XXXXXXXXXXXX-XXXXXX._adb-tls-connect._tcp
[4] pushing the config to /sdcard/Android/data/dev.watchdsh/files
[5] restarting the watch app

--- what the watch recorded ---
    14:51:32  importing config for pc=my-desktop
    14:51:32  wifi lock acquired
    14:51:32  link=Connected
    14:51:32  handshake: harness=ready
    14:51:32  handshake: sessions=9

Paired: the watch reached the harness and read 9 sessions.
```

**Nothing is typed on the watch.** Every failure prints its reason, including the exact
adb commands to run if the watch is not reachable.

If you would rather not push anything, `.\tools\pair-watch.ps1 -Method discovery` leaves
the watch to find the PC itself — open the app and tap **Find my PC**.

Running a script by double-clicking closes its window the instant it ends, which makes a
success look like a crash. Use the `.cmd` wrappers for that: `tools\pair-watch.cmd` and
`tools\lan-test.cmd` both pause before closing.

#### What the config file holds, and what it must not

The config mixes two kinds of fact, and conflating them caused a bug worth knowing about:

| Value | On a re-write | Why |
|---|---|---|
| `relayUrl` for a **LAN** relay | refreshed from this machine's current address | it describes the network, and DHCP moves this machine |
| `relayUrl` for a **remote** relay | inherited | a durable setting, not an observation |
| `pcId` | inherited | the bridge's stable identity |
| `relayToken` | inherited | so an already-paired watch keeps working |
| `pairingSecret` | inherited | same reason |

An earlier version read the LAN address back from the file, which made `--write-config`
self-perpetuating: after DHCP moved this PC, every run copied the previous address straight
back in, and the watch imported a config pointing at whatever machine held that address
before. The symptom was a watch reporting a clean import and then failing to connect, with
nothing pointing at the file. `packages/dsh-bridge/test/config-refresh.mjs` guards it.

#### Checking everything still works

```powershell
.\tools\test-all.ps1
```

It clears `DSH_HOME` first, so the bridge must resolve its dependencies and find the Harness
home the way a double-clicked launcher does — the fallbacks get exercised rather than assumed.
Three suites run: `5/5` config refresh, `13/13` discovery and pairing, `11/11` end to end.

#### LAN (same Wi-Fi as the PC)

```powershell
.\tools\lan-test.ps1
```

It generates the relay token with `crypto.randomBytes` and starts both processes:

```
  The watch must be on the same Wi-Fi network.
  Watch's Relay URL will be:  ws://192.168.1.50:8787

  -- LAN mode: open the watch app and tap "Find my PC" ------------------
  (discovery is answering on udp/8788)

  -- or enter these values by hand --------------------------------------
  Relay URL       ws://192.168.1.50:8787
  Relay token     <43-character token>
  Pairing secret  <43-character pairing secret>
  PC id           my-desktop
  -----------------------------------------------------------------------
```

Press Ctrl+C to stop both. `tools\lan-test.ps1 -Port <n>` changes the port, and a port
that is already serving is reported rather than raced — starting a second relay on a busy
port kills both and looks like a mysterious reconnect loop.

The script binds the relay to every interface but reports this machine's LAN address,
because `0.0.0.0` is not dialable: a watch told to connect to `ws://0.0.0.0:8787`
fails outright. The bridge dials the relay over loopback, so a DHCP lease change
cannot break that link; only the address you type into the watch follows the machine,
and the script re-reads it on every start.

If the watch cannot connect, the usual causes, in order:

1. **The watch is not on the same Wi-Fi.** A Galaxy Watch 6 reaches the network
   either through its phone over Bluetooth or over Wi-Fi directly; for this mode it
   needs Wi-Fi of its own.
2. **The LAN address changed since you paired.** DHCP can move this machine to a new
   address; re-run `lan-test.ps1` and update the Relay URL on the watch. The relay
   token and pairing secret survive restarts, so only the URL changes.
3. **Windows Firewall is blocking inbound TCP 8787.** This machine already has an
   allow rule for the project's own `tools\node\node.exe`, which is what makes the
   LAN mode work without any change; if you move the toolchain, expect a prompt.

`tools\probe-lan.mjs` separates "the relay is not listening" from "something is
filtering the traffic", by probing loopback and every LAN address:

```powershell
node tools\probe-lan.mjs
```

#### Remote (mobile data)

Only needed when the watch is away from this network — see [Away from home](#away-from-home).

#### Doing it by hand

```powershell
# a token both the bridge and the watch will use; keep it secret
$token = & tools\node\node.exe tools\gen-secret.mjs token
New-Item -ItemType Directory -Force .state | Out-Null
Set-Content .state\relay-token $token -NoNewline

# terminal 1: bind every interface so the watch can reach it
node packages\dsh-bridge\src\relay.mjs --port 8787 --host 0.0.0.0 --token-file .state\relay-token

# terminal 2: dial the LAN address, which is also what the watch will be told
node packages\dsh-bridge\src\main.mjs --relay ws://192.168.1.50:8787 `
    --token-file .state\relay-token --state .state
```

`node` is not on this machine's `PATH`; the harness-bundled runtime is at
`tools\node\node.exe`.

### 3. Build and install the watch app

```powershell
.\tools\bootstrap-android.ps1          # JDK 21 + Android SDK (~700 MiB, one time)
.\tools\build-watch.ps1                # -> packages\watch-app\app\build\outputs\apk\debug\app-debug.apk
```

**Install the release APK.** It is 2.5 MiB against 39 MiB for debug, and it starts in about
1.3 s against 4.6 s, because R8 shrinks and optimises it. Both variants permit `ws://`, so
the release build works for LAN mode as well as `wss://` for remote mode — see
[Cleartext on the LAN](#cleartext-on-the-lan) for why that is not a split any more.

Install on the watch. Enable developer options and wireless debugging on the watch
(Settings → About watch → Software → tap Software version 5 times), then pair and install:

```powershell
$adb = tools\android\sdk\platform-tools\adb.exe
& $adb pair <watch-ip>:<pair-port>     # code shown on the watch
& $adb connect <watch-ip>:<debug-port>
& $adb install -r packages\watch-app\app\build\outputs\apk\debug\app-debug.apk
```

### 4. Pair

Open the app. It shows four rows; tap each one and enter the value the bridge printed.
The watch offers dictation, so you can also speak them. Then tap **Connect**.

## Away from home

A watch on mobile data and a PC behind NAT cannot reach each other directly, and this machine has
no server to relay through. The fix is a free Cloudflare Worker, which is the one always-on public
endpoint that needs neither a credit card nor a host to administer. Both sides then dial *out* to
it, which is why no port forwarding and no static IP are involved.

```powershell
.\tools\deploy-relay.ps1
```

That script installs wrangler locally, sets the shared token as a Worker secret, deploys, checks
the deployed relay answers, and writes a watch config pointing at it. **One step is yours:** the
first run stops and asks you to run `wrangler login`, because that opens a browser and needs your
approval — it cannot be automated, and the script says so rather than failing obscurely. Approve
it, run the script again, and it finishes.

You need a free Cloudflare account first: <https://dash.cloudflare.com/sign-up> (email and
password; no domain and no payment method). The free tier covers Durable Objects and WebSocket
Hibernation, and this use is nowhere near its request limit.

### Use a custom domain, not the workers.dev one

**A `*.workers.dev` address is blocked by some ISPs**, and the block is on the hostname rather than
on Cloudflare: measured on one network, TLS to `servername=cloudflare.com` succeeded against the
same Cloudflare IPs while `servername=workers.dev` was reset every time, and `pages.dev` was fine.
Nothing in the relay can work around that, because the block happens before any of it runs.

Attach a domain you control instead:

1. Add the domain to Cloudflare (free plan) and point its nameservers at the pair Cloudflare gives
   you. The zone must be on the same account as the Worker, because a Worker custom domain needs
   Cloudflare to hold the DNS record and the certificate.
2. Wait for the zone to become `active`.
3. Bind the Worker to it — either `wrangler deploy` with a `routes` entry, or the API:

```powershell
# PUT /accounts/<account-id>/workers/domains
#   { "zone_id": …, "hostname": "…", "service": "watch-dsh-relay", "environment": "production" }
```

`tools/cf-status.mjs` reports the zones and custom-domain bindings on the account, which is how
you tell whether step 1 is done before spending time on step 3:

```powershell
node --import "file:///…/tools/resolve-public.mjs" tools\cf-status.mjs <account-id>
```

Then point the bridge and the watch at `wss://<your-domain>` and check it from outside:

```powershell
node packages\dsh-bridge\src\main.mjs --relay wss://<your-domain> `
    --token-file .state\relay-token --state .state
```

### If the API hostname resolves to a wrong address

Some networks answer `api.cloudflare.com` with addresses that are not Cloudflare's, so wrangler
times out while `dash.cloudflare.com` works — which reads as a broken login rather than a DNS
problem. `tools/resolve-public.mjs` replaces `dns.lookup` for one process and is preloaded by the
deploy script, so no administrator rights and no system DNS change are needed.

Note that `dns.setServers()` alone does **not** fix this: it changes `dns.resolve*` but not
`dns.lookup`, and `fetch` goes through `lookup`.


By hand, if you prefer:

```powershell
cd packages\dsh-bridge
node ..\..\node_modules\wrangler\bin\wrangler.js secret put RELAY_TOKEN   # paste .state\relay-token
node ..\..\node_modules\wrangler\bin\wrangler.js deploy
```

`wrangler.toml` is already configured. Then restart the bridge pointed at the deployed Worker:

```powershell
node packages\dsh-bridge\src\main.mjs `
    --relay wss://watch-dsh-relay.<your-subdomain>.workers.dev `
    --token-file .state\relay-token --state .state
```

and enter that `wss://` URL as the watch's **Relay URL**. The relay token and pairing secret are
unchanged, so the watch does not need re-pairing — only the address moves.

The Worker routes opaque frames and cannot read them: prompts, replies, transcripts, and approvals
are sealed end to end under the pairing secret, which never reaches it. What it does see is each
connection's pc id and the shared token, so treat the Worker's URL plus that token as the thing to
protect.

Notes on the free tier: Durable Objects and WebSocket Hibernation are both on the free plan, and
incoming WebSocket messages bill at a 20:1 ratio with protocol pings free, so an always-attached
bridge plus occasional watch traffic stays far inside the daily limits. The relay routes opaque
ciphertext and holds no key, so a compromised relay can drop traffic but cannot read a prompt or
forge an approval.

If you do have a host (a home server, a VPS), skip the Worker entirely and run
`node src/relay.mjs` on it with `--host 0.0.0.0` and a TLS terminator in front, then point the
bridge and the watch at its `wss://` URL.

## Security model

- **The relay is untrusted.** Every application frame is sealed with AES-256-GCM under a key
  derived from a 32-byte pairing secret the relay never sees. Two directional keys
  (`SHA-256("v1:" + direction + ":" + secret)`) stop a frame from being replayed back at its
  sender. See [docs/protocol.md](docs/protocol.md).
- **The Harness is untouched.** It keeps its loopback bind, its cookie, and its refusal to expose
  remote code execution to the network. The bridge is a local client, exactly like a browser.
- **The watch surface is narrow.** The bridge exposes nine commands and ten events, not the
  Harness's 84 endpoints. A watch cannot, for example, read arbitrary files: no such frame exists.
- **The pairing secret is the whole trust anchor.** Anyone who has it and the relay URL can drive
  the agent. It is generated on first run, written `.state/pairing-secret` with owner-only
  permissions, and never leaves the PC and the watch.

## Verification

The chain is tested without an Android device by driving the same sealed frames the watch sends:

```powershell
node packages\dsh-bridge\test\e2e.mjs
```

```
PASS  bridge answers hello
PASS  session list returns rows
PASS  session created
PASS  prompt accepted
PASS  turn ended within budget
PASS  streamed text arrived                      ("watch-ok")
PASS  streamed text matches the request
PASS  transcript has user and assistant entries   (["user","user","assistant"])
PASS  assistant entry contains the reply
PASS  empty prompt is rejected                    (bad-request)
PASS  unknown command is rejected                 (unsupported)
11/11 checks passed
```

Other tools:

```powershell
node packages\dsh-bridge\src\probe.mjs     # is the Harness reachable with a minted cookie?
node packages\dsh-bridge\src\sample.mjs    # dump real session frames
node packages\dsh-bridge\src\catalog.mjs   # every Remote endpoint this Harness mounts
```

## Cleartext on the LAN

Android refuses cleartext traffic by default, which would reject the `ws://` URL that LAN mode
needs: a relay on a local address has no TLS terminator in front of it. The app therefore permits
cleartext in **every** build variant, from `app/src/main/res/xml/network_security_config.xml`.

That is a deliberate reversal of an earlier design that allowed it in `debug` only. The split
sounded safer but made the build worth installing — the release one, at 2.5 MiB and a 1.3 s start
— unable to reach a LAN relay at all, while LAN mode is the mode that needs no Cloudflare account
and therefore the one most people will use. A build that cannot do the common thing is not a safer
build.

What cleartext does and does not expose:

- **Not exposed:** prompts, replies, transcripts, and approval decisions. Those are sealed end to
  end with AES-256-GCM under the pairing secret, which the relay never sees, so a LAN observer
  gets ciphertext whether the transport is `ws://` or `wss://`.
- **Exposed:** the relay token travels in the connection URL, so anyone capturing LAN traffic
  could read it and impersonate *a* watch to the relay. They still could not read a conversation:
  that needs the pairing secret, which is delivered only over an authenticated connection and
  never appears in a URL.

Remote mode uses `wss://`, so the token is inside TLS there. On a LAN the token is only as private
as the Wi-Fi, which is the same assumption you already make for anything else on it. If you would
rather not have it on the wire at all, rotate it with `tools\gen-secret.mjs token` after a session
on an untrusted network, or use remote mode.

## Environment notes

Two constraints shaped the tooling, both worth knowing before changing the scripts:

- **Only Node can reach the network here.** PowerShell's `Invoke-WebRequest` and `curl` fail with
  a TLS error under this sandbox, so every download goes through `tools/download.mjs` (Node's
  `fetch`).
- **`gradle.org` is unreachable, GitHub releases are unreliable.** Gradle comes from the Tencent
  mirror and is verified against the SHA-256 published by gradle.org. The Android SDK comes from
  `dl.google.com`, which works.

`tools/build-watch.ps1` pins the toolchain under `tools/` and touches nothing global. A few
version choices are deliberate and documented where they are made:

- **compileSdk 37 preview (`CinnamonBun`).** Wear Compose 1.7 is the first release with the
  material3 `Scaffold` this app uses, and it requires API 37, which currently exists only as a
  preview platform. `targetSdk` stays at 35 so no untested runtime behaviour is opted into.
- **No text-input component.** Wear Material 3 ships no text field — a watch has no keyboard — so
  every text value, including the four pairing values, is entered through the system input
  activity that dictation uses.
- **Icons are declared inline.** `material-icons-extended` added ~60 MiB to the APK; three hand-written
  vectors replaced it and cut the debug APK from 68.8 MiB to 38.8 MiB.
