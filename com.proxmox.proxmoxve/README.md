# Proxmox VE for Homey

[![Homey App Store](https://img.shields.io/badge/Homey-App%20Store-orange)](https://homey.app/a/com.proxmox.proxmoxve)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Control and monitor your Proxmox VE cluster directly from Homey. This app provides real-time insights and automation capabilities for your virtual infrastructure.

## ⚡ Key Features

*   **Cluster & Node Monitoring**: Real-time CPU, Memory, Disk, and Active VM/LXC counts per node, plus cluster quorum status.
*   **Virtual Control**: Start, Stop, Shutdown, Reboot, Migrate, Snapshot (create/rollback), and Backup VMs and Containers via Flows. Bulk Start/Shutdown for every VM/Container on a node.
*   **Per-VM/Container Devices**: Optionally pair individual VMs/Containers as their own Homey devices, with an on/off tile and live CPU/Memory/Uptime/Network sensors.
*   **Smart Automation**: Flow triggers for VM start/stop, node online/offline, fallback engaged/restored, cluster quorum lost/restored, and CPU/Memory usage thresholds - not just conditions to poll.
*   **Dashboard Widgets** (Homey Pro 2023+): Cluster Overview (counts, fallback/quorum status, storage usage), Node Detail (CPU/Memory/Disk, VM/LXC counts, online status), and VM/Container Control (live start/shutdown buttons) - right on your Homey dashboard.
*   **Robust Failover**: Automatically switches to backup nodes if the primary host is down, ensuring your automations never fail.
*   **Auto-Discovery**: Automatically detects and adds cluster nodes (and, optionally, VMs/Containers) as devices.

## 🚀 Quick Start

1.  **Prepare Proxmox**:
    *   Log in to Proxmox VE.
    *   Go to **Datacenter > Permissions > API Tokens**.
    *   Create a token (e.g., `homey@pve!token`) and uncheck "Privilege Separation" (or ensure proper permissions).
    *   *Copy the Secret immediately!*

2.  **Add Device in Homey**:
    *   Add a **Proxmox Cluster** device.
    *   Enter your **Hostname/IP**, **User** (e.g., `root@pam`), **Token ID**, and **Secret**.
    *   Test Connection & Save.

3.  **Done!**
    *   The cluster device will appear immediately.
    *   Individual **Node devices** will be discovered and added automatically.

## ⚙️ Configuration

*   **Polling Interval**: Configurable (default: 5m for Cluster, 1m for Nodes).
*   **SSL**: Supports self-signed certificates (enable in Device Settings).
*   **Failover**: "Backup Node IPs" are auto-learned by the app. No manual config needed.
*   **Reverse Proxy / Non-default Port**: If Proxmox is reachable behind a reverse proxy on a port other than 8006, set it in the optional Port field (pairing or Device Settings). This port is used for every connection, including auto-discovered backup nodes.

## ❓ Troubleshooting

*   **Connection Failed?**: Verify your API Token permissions and network reachability.
*   **Self-Signed Cert?**: Enable "Allow Self-Signed Certificates" in the device settings.
*   **Status not updating?**: The app sends data in real-time. If the UI lags, try refreshing the Homey app.

---
[Report an Issue](https://github.com/kay-arne/HomeyApps/issues) | [Source Code](https://github.com/kay-arne/HomeyApps)