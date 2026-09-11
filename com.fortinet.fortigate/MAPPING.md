# Adjusting the FortiOS field mapping

`lib/mapping.js` is the one place that reads FortiOS's raw JSON. Everything
else in the app (drivers, devices, the pairing flow) works with the small,
clean objects it returns (`{ id, name, connected, ports, ... }`), not the
raw API response. If a value comes back `undefined` on your firmware, this
is the only file you should need to touch.

## 1. Get the raw JSON from your own FortiGate

```bash
node tools/inspect.js <fortigate-host> <api-token> switches --insecure
node tools/inspect.js <fortigate-host> <api-token> aps --insecure
node tools/inspect.js <fortigate-host> <api-token> status --insecure
```

Drop `--insecure` if your FortiGate has a trusted certificate. Add
`--vdom=<name>` if you use VDOMs.

## 2. Find the field you're missing

Say `switchTotalPoeWatts()` keeps returning `undefined` for a switch you
know has PoE devices attached. Look at the `switches` dump for that
switch's `ports` array and find the field that holds the wattage, e.g.:

```json
{
  "interface": "port3",
  "poe-status": "enable",
  "my-actual-power-field": 8.4
}
```

## 3. Add it to the candidate list

Open `lib/mapping.js` and find `mapPort()`. Add your field name to the
`poeWattsRaw` candidate list:

```js
const poeWattsRaw = pick(raw, [
  'poe-power', 'poe_power', 'power', 'poe-detected-power', 'detected-power',
  'power-consumption', 'poe-power-consumption', 'poe-consumption',
  'my-actual-power-field', // <- added
]);
```

`pick()` already ignores case and `-`/`_`/space differences, so you only
need to add a spelling if the *word itself* differs, not just its
formatting.

## Where each value comes from

| Value | Function | What to check if it's wrong |
|---|---|---|
| Switch id/name/connected state | `mapSwitch()` | the raw switch object's top-level keys |
| Per-port PoE enabled/watts | `mapPort()` | one entry of the switch's `ports` array |
| Switch total PoE watts | `switchTotalPoeWatts()` | sums `mapPort()` results, nothing to adjust here |
| AP id/name/connected state/IP | `mapAP()` | the raw AP object's top-level keys |
| AP uplink switch + port (for power correlation) | `mapAP()` | `uplinkSwitchId` / `uplinkPort` candidates |
| AP client count | `mapAP()` | either a `radio[].clients` field or a top-level `clients` field |
| Which port powers an AP | `findApPoePort()` | matches `mapAP().uplinkSwitchId`/`uplinkPort` against `mapSwitch().ports[].name` |

After editing, restart the app (`homey app run` picks up changes) and check
the affected device's capability value, or re-run the relevant
`tools/inspect.js` call and eyeball the field by hand.
