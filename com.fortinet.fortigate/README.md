# FortiGate for Homey

A Homey (Pro) app that discovers the FortiSwitch and FortiAP devices managed
by your FortiGate, lets you add them to Homey as monitored devices, tracks
their PoE power draw, port/client/throughput stats, and raises Flow alerts
for connectivity and security events.

This app talks to your FortiGate over the local network via its REST API —
nothing goes through the cloud. It needs a **Homey Pro**, since it requires
local LAN access.

## What it does

- **Discovery & pairing** — after you add your FortiGate once, the app can
  list every FortiSwitch and FortiAP it currently manages so you can add the
  ones you want as Homey devices, each individually monitored from then on.
- **PoE power monitoring** — each FortiSwitch device reports its total PoE
  power delivered (sum of its PoE ports) and each FortiAP reports its own
  PoE draw when the app can work out which switch port powers it (see
  *PoE monitoring caveats* below). Both use dedicated capabilities
  (`switch_poe_watts` / `ap_poe_watts`) rather than Homey's standard
  `measure_power`, so they're **not** counted in Homey's home Energy total —
  see that section for why.
- **Switch port monitoring** — ports online vs. total, PoE-active ports vs.
  PoE-capable ports, and rx/tx throughput per switch.
- **AP client & throughput monitoring** — connected clients (total and
  per-band: 2.4/5/6GHz) and rx/tx throughput per AP.
- **WAN throughput** — on the FortiGate device, once you tell it which
  interface(s) are your WAN in its settings (FortiOS's monitor API doesn't
  expose an interface's configured role).
- **Connectivity alerts** — Flow triggers fire when a switch or AP goes
  offline or comes back, plus a Flow condition to check "is online" and an
  action to refresh a device's data on demand.
- **Power threshold alerts** — Flow triggers for "power draw rises above /
  drops below X watts", for spotting a switch or AP drawing unusually
  much or little power.
- **Security event alerts** — a Flow trigger that fires with the event's
  type, severity, message and source/destination IP, fed by a FortiGate
  Automation Stitch (see below) rather than by polling logs.
- **Power cycle via PoE** — a Flow action that turns a device's PoE port off
  and back on, useful for "if an AP has been offline for 5 minutes, power
  cycle it".

## Prerequisites

- A Homey Pro, on the same network as the FortiGate (or reachable from it).
- A FortiGate managing at least one FortiSwitch and/or FortiAP via FortiLink,
  if you want those benefits — the FortiGate device alone can also be added
  just for security-event alerts.
- Node.js and the Homey CLI (`npm install -g homey`) if you're going to run
  or modify this app yourself, per Homey's own developer docs.

## 1. Create a REST API admin on the FortiGate

1. In FortiOS, go to **System > Administrators > Create New > REST API Admin**.
2. Give it a name (e.g. `homey-readonly`) and an **Administrator Profile**
   with read-only access to at least: System, Switch Controller, WiFi
   Controller. Only grant write access to Switch Controller if you plan to
   use the "power cycle via PoE" action.
3. Under **Trusted Hosts**, restrict it to your Homey's IP (a `/32`), or a
   range covering it (e.g. your LAN's `/24`) if Homey's address can change.
   A DHCP reservation for the Homey Pro is recommended so this stays narrow.
4. Save. FortiOS shows the **API token once** — copy it now; you can't
   retrieve it again later (only regenerate a new one).
5. Note that FortiGate's management HTTPS interface typically uses a
   self-signed certificate. This app has an "accept self-signed
   certificate" checkbox for that; for anything beyond a home LAN, consider
   installing a proper certificate instead of leaving that checked.

## 2. Install and run the app

```bash
npm install
homey app run
```

`homey app run` (and `homey app build`/`validate`) automatically compiles
the `.homeycompose/` + `drivers/*/driver.compose.json` sources in this
project into the final `app.json` — you don't need to write that by hand.

## 3. Pair your devices

1. **Add a FortiGate** first: host/IP, HTTPS port, VDOM (if used), and the
   API token from step 1.
2. **Add FortiSwitches** and/or **Add FortiAPs**: pick which paired FortiGate
   to discover through (skipped automatically if you only have one), then
   select the switches/APs you want monitored from the discovered list.

## PoE monitoring caveats — please read

FortiGate's monitor API reports **PoE output power on switch ports**, not
the switch's own AC input draw (which the API generally doesn't expose).
So:

- A FortiSwitch's `switch_poe_watts` is the sum of what it's delivering
  over PoE to connected devices — a good proxy for "load on this switch",
  not its total electricity consumption.
- An FortiAP's `ap_poe_watts` is only added when the app can match it to
  the PoE port on a FortiSwitch that powers it. If an AP is powered by a
  non-FortiSwitch injector, a plain power brick, or the correlation simply
  fails for your setup, that AP is added **without** the power capability
  rather than showing a permanently wrong or empty number.
- Neither of these use Homey's standard `measure_power` capability, so
  neither counts toward Homey's home Energy total. That's deliberate: if
  you track a switch's real consumption with a smart socket on its power
  input, that reading already includes everything the switch delivers
  onward over PoE — counting an AP's share again here would double-count
  it. These capabilities are for monitoring load/health, not for adding up
  to your home's actual electricity usage.

## Push alerts via FortiGate Automation (recommended for security events)

Polling FortiGate's log API for security events is heavy and its exact
schema varies by firmware, so this app instead exposes two small local
webhook endpoints and expects your FortiGate to call them via its built-in
**Automation** framework (System > Automation), which is also the more
timely option since it pushes instead of waiting for the next poll:

- `http://<homey-local-ip>/api/app/com.fortinet.fortigate/webhook/security-event`
- `http://<homey-local-ip>/api/app/com.fortinet.fortigate/webhook/connectivity-event`

To wire this up:

1. Open your paired FortiGate device's **Settings** in Homey and copy the
   generated **Webhook secret**.
2. On the FortiGate, create an **Automation Trigger** for the event you
   want (e.g. IPS Anomaly, Virus Detected, or FortiSwitch/FortiAP
   disconnected), then an **Automation Action** of type **Webhook**
   pointing at the relevant URL above, method `POST`, content-type
   `application/json`.
3. Set the webhook's request body to include your secret plus the fields
   the app expects:
   - Security event: `{"secret": "...", "type": "ips", "severity": "critical", "message": "...", "srcip": "...", "dstip": "..."}`
   - Connectivity event: `{"secret": "...", "id": "<switch-id or AP serial>", "state": "offline", "reason": "..."}`

   The exact placeholder syntax for pulling live values into that body
   (e.g. `%%log.srcip%%`) depends on your FortiOS version and the trigger
   type — the Automation Action editor lists the fields available for
   whichever trigger you picked. Map whatever it offers onto the JSON keys
   above.
4. Connectivity alerts also work without any of this, via periodic polling
   (see each device's "Poll interval" setting) — the webhook just makes
   them near-instant instead of waiting for the next poll.

## Verifying/adjusting the FortiOS field mapping

FortiOS monitor API field names shift slightly between firmware versions.
`lib/mapping.js` tries several likely spellings for each value it needs
(PoE watts, connection state, etc.) and degrades gracefully rather than
guessing, but if something reads as empty on your firmware:

```bash
node tools/inspect.js <fortigate-host> <api-token> switches --insecure
node tools/inspect.js <fortigate-host> <api-token> aps --insecure
```

This dumps the raw JSON your FortiGate actually returns. See `MAPPING.md`
for how to fold a different field name into `lib/mapping.js`.

## Project structure

```
app.js                        App-level Flow card wiring
api.js                        Public webhook routes for Automation push alerts
lib/FortiGateAPI.js           REST API client (auth, requests)
lib/mapping.js                Defensive JSON field extraction (see MAPPING.md)
lib/NetworkDeviceBase.js      Shared poll/online-offline/threshold logic for switch+AP devices
drivers/fortigate/            The FortiGate bridge device (holds credentials)
drivers/fortiswitch/          FortiSwitch devices
drivers/fortiap/              FortiAP devices
tools/inspect.js              Standalone CLI to dump raw FortiOS JSON
tools/self_check.js           Structural sanity check (no Homey CLI/network needed)
```

## Known limitations

- Only one FortiGate's worth of switches/APs are queried per bridge device;
  add multiple FortiGate devices for multiple sites.
- The "power cycle via PoE" action needs write access on the API admin's
  profile and a switch with at least one PoE-enabled port.
- Security-event alerting depends on you configuring an Automation Stitch;
  it is not automatic out of the box (see above for why).

## License

MIT
