# Release Notes

## v1.3.0 - Widgets Fixed (Homey Web API)

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
