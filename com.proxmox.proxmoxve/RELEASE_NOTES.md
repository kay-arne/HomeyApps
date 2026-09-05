# Release Notes

## v1.2.11 - Dashboard Widgets Reworked Around Live Operational Status

### 🚀 New Features
- **VM/Container Control widget rebuilt**: instead of picking one VM/Container per widget, it
  now shows a live, scrollable list of every VM/Container in the cluster at once, each with a
  Start/Shutdown toggle and a Restart button - backed by a single cluster-wide API call, so it
  doesn't even require the guest to be paired as its own Homey device.
- **New Node Status widget**: same idea for nodes - a live list of every node's online state,
  CPU/Memory usage, and running VM/LXC counts, from one widget.
- Both replace the short-lived time-window chart widgets from the last few builds. Homey's own
  Insights already keeps full historical data for every measured capability in this app - a
  second, app-side history buffer just for charts turned out to be redundant, and its data didn't
  match Insights anyway (only capturing whatever ran since the app last restarted). If you want
  graphs, add Homey's own Insights widget for the capability you're interested in - it'll show
  real history, not a partial reconstruction.

### 🐛 Fixes
- **Widget lists couldn't be scrolled**: a known Homey platform quirk where the dashboard's own
  touch handling intercepts vertical swipes meant for a widget's inner scrollable list once more
  than one widget shares a column. Backup & Snapshot Status, VM/Container Control, and Node
  Status now claim the scroll gesture themselves so the list actually scrolls.
- **Widget styling brought in line with Homey's guidelines**: borders, border radii, and the
  Restart icon now use the documented `--homey-line`/`--homey-border-radius-*` tokens and the
  `.homey-custom-icon-*` mask-image pattern instead of ad-hoc values and an inline SVG.
- **Real preview images for all four widgets**: they were still showing the generic "TODO REPLACE
  ME" placeholder from the CLI scaffold. Replaced with simple, on-brand previews (no screenshots
  or text, per Homey's App Store guidelines) for both light and dark mode - and about a quarter
  of the file size of the old generic placeholders.

## v1.2.10 - Capability Icons Redesigned to Match

### 🐛 Fixes
- **Remaining capability icons redesigned**: CPU, Memory, Disk, Network In/Out, Uptime,
  Connected via Host, Using Fallback Connection, Node Offline / Quorum Lost, and the Node/VM/LXC
  count icons were still the old mixed icon set from before v1.2.9's driver icon redesign. All
  redrawn as line art in the same style as the new driver icons - the VM/LXC count icons are
  literally scaled-down copies of the Cluster/Node driver icons for a consistent look throughout
  the app.
- **Memory Usage showed the CPU icon**: a leftover copy-paste bug - `measure_memory_usage_perc`
  pointed at `assets/cpu.svg` instead of its own icon. It now uses a dedicated RAM icon.
- The app icon (`assets/icon.svg`, Proxmox's own logo) is unchanged - Homey's guidelines
  explicitly allow using a supported brand's own icon there.

## v1.2.9 - Driver Icons Redesigned for App Store Compliance

### 🐛 Fixes
- **Driver icons redesigned as line drawings**: Homey's [App Store icon guidelines](https://apps.developer.homey.app/app-store/guidelines)
  require driver icons to be clean vector line drawings (dimension added through angles and line
  work), not filled silhouettes - a filled icon "will appear as a solid shape... and will not be
  approved". The Cluster, Node, VM and Container driver icons were solid-filled shapes (two of
  them borrowed from Font Awesome), so all four were redrawn from scratch as line art: Cluster is
  three connected nodes, Node is an angled rack server unit, VM is a desktop monitor, and
  Container is an isometric box.
- **Node driver had no icon of its own**: it was silently reusing the app's own icon (the Proxmox
  logo), which the guidelines explicitly disallow ("don't use a driver icon as your app icon").
  It now has its own dedicated icon like every other driver.
- Regenerated the small/large/xlarge driver images from the new icons to match.

## v1.2.8 - Live Graphs in the Node Detail & VM/Container Control Widgets

### 🚀 New Features
- **Node Detail widget**: CPU and Memory are now live sparkline graphs (rolling ~5-minute
  window, built up while the widget is on screen) instead of static bars, so you can see recent
  trends at a glance. Disk usage stays a bar - it doesn't move quickly enough for a graph to add
  much.
- **VM/Container Control widget**: added CPU, Memory, and Network throughput graphs below the
  existing start/shutdown control. Network throughput is computed client-side from the raw
  cumulative byte counters (the existing Network In/Out sensor is rounded to whole GB, too coarse
  for a live rate at this refresh interval) - shown as a combined in+out rate (B/s - MB/s,
  auto-scaled).
- Both widgets clear their graphs when the device goes offline/stops, rather than showing a flat
  line of stale data.

## v1.2.7 - VM/Container Icon Fix & LXC Disk Usage

### 🐛 Fixes
- **VM/Container devices all showed the same icon**: the pairing code pointed the per-device
  icon override at `/assets/container.svg` (the top-level app assets folder), but Homey
  resolves per-device pairing icons relative to the driver's own `drivers/proxmox-vm/assets/`
  folder - so the override silently never resolved and every device fell back to the driver's
  default icon. Fixed by placing `container.svg` inside the driver's own assets folder and
  referencing it correctly. Only affects newly-paired devices - already-paired VM/Container
  devices keep whatever icon they got at pairing time (Homey has no way to change a device's
  icon after pairing); remove and re-add an affected device to pick up the fix.

### 🚀 New Features
- **LXC-only disk usage sensor**: added `measure_disk_usage_perc` to Container devices
  specifically (not VMs) - Proxmox reliably reports actual used disk space for LXC containers
  via a per-container status call, but not for QEMU VMs without the guest agent. Rather than
  show an always-empty sensor on VM devices, it's only present on Container devices at all.

## v1.2.5 - Snapshots, Backup Trigger, Bulk Node Actions & Richer VM Metrics

### 🚀 New Features
- **Snapshot management**: `Create Snapshot` and `Rollback to Snapshot` Flow actions for
  VMs/Containers (rollback's snapshot picker depends on the VM/Container already being selected
  in the same card).
- **Backup trigger**: `Backup VM/Container` Flow action (vzdump), with an autocomplete storage
  picker. Starts the backup and returns once it's confirmed running - does not wait for it to
  finish. A backup-status sensor/trigger is a possible follow-up, not included here.
- **Bulk node actions**: `Start all VMs/Containers on Node` and `Shutdown all VMs/Containers on
  Node (Graceful)` - the graceful counterparts to the existing force-stop-all action.
- **Richer VM/Container metrics**: added Uptime, Network In (Total), and Network Out (Total)
  capabilities to the `proxmox-vm` driver - all computed from data already being polled, no
  extra API calls. Per-VM disk usage and IP address are not included - neither is reliably
  available from Proxmox without the QEMU guest agent for VMs (LXC has partial support, but
  shipping it only for one VM type was inconsistent enough to defer).

## v1.2.4 - Removed the New Permission

### 🐛 Fixes
- **Removed the `homey:manager:api` permission** added in 1.2.3. Widgets now pick their device
  via a custom search field (a widget "autocomplete" setting, backed by this app's own device
  list) instead of Homey's built-in device picker - the built-in picker is what forced the Web
  API detour in the first place, since it hands back a platform-wide device ID this app has no
  permission-free way to resolve. The custom picker returns our own device ID directly, so no
  extra permission is needed at all, and the `homey-api` dependency is gone again.
- **VM/Container Control is now single-device**: since the custom picker (unlike Homey's native
  one) doesn't support multi-select, each widget now shows and controls exactly one VM/Container.
  Add multiple widgets to your dashboard to monitor/control several - a more typical dashboard
  pattern anyway.

## v1.2.3 - Widgets Fixed (Homey Web API)

### 🐛 Fixes
- **Widgets couldn't find any device**: on-device testing showed a widget's selected device ID
  (from `Homey.getDeviceIds()`) is a Homey platform-wide UUID, completely separate from this
  app's own pairing ID that `homey.drivers`/`Driver#getDevice()` matches against - so the v1.2.x
  widgets could never resolve a device. Widgets now use the Homey Web API (`homey-api`, via
  `HomeyAPI.createAppAPI()`) instead, which operates in that same platform-wide ID space. Device
  selection, live data, and the VM/Container Control widget's start/shutdown buttons should now
  work correctly.
- **New permission required**: `homey:manager:api`, needed for the Web API above. Only used by
  the widgets - core device polling and Flow actions are unaffected and don't need it.

## v1.2.0 - Dashboard Widgets

### 🚀 New Features
- **Dashboard Widgets** (Homey Pro 2023+): three new widgets for the Homey dashboard, separate
  from device tiles and Flows:
    - **Proxmox Cluster Overview**: node/VM/LXC counts, connection fallback and cluster quorum
      status, and per-datastore storage usage bars, for a selected Cluster device.
    - **Proxmox Node Detail**: CPU/Memory/Disk usage bars, VM/LXC counts, and online/offline
      status for a selected Node device.
    - **Proxmox VM/Container Control**: a live list of selected VM/Container devices with
      running-state and start/shutdown buttons, right on the dashboard.
  Widgets poll every 15 seconds while visible and reuse the app's existing polling caches, so
  they don't add extra load on Proxmox beyond normal operation.

## v1.1.0 - Flow Triggers, New VM Driver & Performance

### 🚀 New Features
- **Flow Triggers**: The app previously had zero trigger cards. Added:
    - `A VM/Container started` / `stopped` (per-VM, with name/vmid tokens).
    - `Node came online` / `went offline`.
    - `Connection switched to a fallback node` / `restored to the primary node`.
    - `Cluster lost quorum` / `regained quorum`.
    - `CPU usage is above a threshold` / `Memory usage is above a threshold`.
- **New "Proxmox VM/Container" driver**: individual VMs/LXCs can now be paired as their own
  Homey devices with an on/off tile (start/shutdown) and live CPU/Memory sensors - giving you
  dashboard tiles and automatic "turned on/off" Flow cards per VM, in addition to the existing
  cluster-level target-VM Flow cards.
- **Reboot actions**: `Reboot VM/Container` and `Reboot Node`.
- **Migrate VM/Container action**: move a VM/Container to another node in the same cluster.
- **New sensors**: Cluster Quorum Lost (alarm) and Node Disk Usage (%).
- **Configurable API port**: added an optional Port field (pairing and device settings) for
  setups running Proxmox behind a reverse proxy on a non-default port. Defaults to 8006, matching
  existing behavior. Applies to every connection the app makes, including auto-discovered
  backup/failover nodes, since a reverse proxy is typically the single ingress point for the
  whole cluster. (Thanks for the suggestion!)

### 🐛 Fixes
- **"Stop Node (Force)" repurposed**: Proxmox's node power API only supports `reboot`/`shutdown` -
  there is no remote "force power off" for the node itself. This card previously sent an invalid
  command and always failed. It now force-stops every running VM/Container on that node instead,
  which is both valid and a genuinely useful "emergency stop everything on this node" action.
  Existing Flows using this card keep working, just with corrected (and now functional) behavior.

### ⚡ Performance & Reliability
- Reused HTTPS connections (fixed a bug where a fresh `Agent` - and its connection pool - was
  created on every single API request, defeating `keepAlive`).
- Newly discovered backup hosts are now fed into the live failover manager immediately, instead
  of only taking effect after an app/device restart.
- Node devices now poll with jitter, like the cluster device already did, to avoid multiple
  devices firing identical requests in lockstep.
- Health-check pings now run in parallel instead of sequentially.
- Cluster status/resources and node status/resources are now fetched in parallel per poll.
- Flow-action VM lookups are now short-cached so a burst of actions (e.g. a scene stopping
  several VMs) shares one lookup instead of each firing its own.

## v1.0.7 - UI Improvements
- **Visual Updates**:
    - Updated App Icon to a sleek black design.
    - Optimized driver icons for better contrast.

## v1.0.6 - Certification Fixes
- **App Store Improvements**:
    - Updated app description to meet marketing guidelines.
    - Updated driver icons to ensure uniqueness and clarity.

## v1.0.0 - Production Release

### 🚀 Major Improvements
- **Strict Timeout for Node Checks**: Implemented a forced 3-second timeout for the "Node is online" flow card. This ensures reliability even if the underlying network layer (like DNS or Socket) hangs, preventing 30s+ delays.
- **Production Readiness**:
    - Full security review and linting cleanup.
    - Passed official Homey Store validation (`publish` level).

### 🐛 Fixes
- **Polling Persistence**: Fixed a bug where setting polling to "0" (or Disabled) would revert to default on app restart.
- **UI Consistency**: Updated Memory capability icon to match the CPU icon style.

## v0.9.0 - Major Performance & Reliability Update

### 🚀 New Features
- **Robust Cluster Failover**:
    - Added automatic discovery of backup node IPs.
    - Implemented a "Backup Node IPs" (Advanced) setting that auto-populates on successful connection.
    - If the primary node is down, the app now seamlessly fails over to backup nodes, even on a cold start.
- **Node-Level Monitoring**:
    - Added `Total Active VMs` and `Total Active LXCs` capabilities to Node devices.
    - Real-time tracking of running instances per node.
- **Connection Health Improvements**:
    - Suppressed transient "Device Unavailable" errors when running in fallback mode to prevent UI flapping.
    - Added intelligent health checks that ping Primary, Preferred, and Random nodes to maintain an up-to-date availability map without storming the API.

### ⚡ Optimizations
- **Polling Logic Overhaul**:
    - Fixed a critical bug where the polling interval setting was being ignored (stuck at 5 minutes).
    - Implemented `force-refresh` for polling cycles to ensure real-time data while maintaining a cache for other operations.
    - Reduced default health check interval to 60s (conservative) to reduce load on Proxmox.

### 🛠 Fixes
- **Stale Data Fix**: Fixed an issue where flow cards (e.g., "Is VM Running") would return cached/stale data. Now they always fetch fresh status.
- **SDK Compliance**: Removed legacy manual capability events in favor of Homey SDK v3 best practices.
- **UI Improvements**: Standardized capability titles for clarity ("Total Active VMs" vs "Active VMs").
