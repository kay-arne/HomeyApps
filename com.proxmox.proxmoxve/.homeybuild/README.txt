Proxmox VE Integration for Homey

This app integrates your Proxmox VE server with Homey, allowing you to monitor and control your virtual machines and containers directly from your smart home.

Features:
- Monitor cluster and node status (CPU/RAM)
- View Active VM and container counts (per node and cluster total)
- Control VMs (start, stop, shutdown)
- Flow cards for VM status automation
- Robust Cluster Failover (automatic backup host switching)
- Connection health monitoring
- Custom guided pairing process

Requirements:
- Proxmox VE server with API access
- API token with appropriate permissions
- Network connectivity between Homey and Proxmox server

Setup:
1. Create an API token in Proxmox VE
2. Add the Proxmox Cluster device in Homey
3. Enter your server details and credentials
4. Test the connection and create your device

The app will automatically discover and add individual nodes for detailed monitoring.

For support and documentation, visit the GitHub repository.
