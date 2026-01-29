Manage your Proxmox VE infrastructure directly from Homey.

This app integrates your Proxmox VE cluster with Homey, giving you real-time insights and control over your virtual environment.

Key Features:
*   Cluster & Node Monitoring: See CPU, Memory, and active VM/LXC counts at a glance.
*   Smart Control: Start, Stop, and Shutdown VMs and containers via Homey Flows.
*   Automation Triggers: Create flows based on VM state (running/stopped) or Node status (online/offline).
*   High Availability Support: If your primary Proxmox node goes down, the app automatically fails over to backup nodes to keep your automations running.
*   Auto-Discovery: Simply add your cluster, and all nodes are automatically discovered and added as devices.

Getting Started:
1.  Create an API Token in Proxmox (Datacenter > Permissions > API Tokens) with proper privileges (uncheck "Privilege Separation" or configure granular permissions).
2.  Add the Proxmox Cluster device in Homey.
3.  Enter your Hostname, User (e.g., root@pam), and API Token.
4.  The app will connect and find your nodes automatically!

Notes:
*   Supports self-signed certificates (enable in device settings).
*   Configurable polling intervals for real-time updates.
