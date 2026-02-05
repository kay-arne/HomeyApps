# Release Notes

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
