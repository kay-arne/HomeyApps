# Proxmox VE Integration for Homey

[![Homey App Store](https://img.shields.io/badge/Homey%20App%20Store-v0.8.4-orange)](https://apps.developer.homey.app/apps/app/com.proxmox.proxmoxve/build/5)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Homey SDK](https://img.shields.io/badge/Homey%20SDK-v3-green.svg)](https://apps.developer.homey.app/)

A comprehensive Homey app that integrates your Proxmox VE server with your smart home, allowing you to monitor and control your virtual machines and containers directly from Homey.

## 🚀 Features

### 📊 **Monitoring**
- **Cluster Status**: Monitor your entire Proxmox cluster health
- **Node Monitoring**: Individual node CPU and memory usage
- **VM/Container Counts**: Real-time statistics of running VMs and LXC containers
- **Connection Health**: Automatic connection monitoring with fallback alerts

### 🎮 **Control**
- **VM Management**: Start, stop, and shutdown virtual machines
- **Flow Cards**: Create automations based on VM status
- **Real-time Updates**: Live polling of server statistics

### 🔧 **Advanced Features**
- **Custom Pairing**: Guided setup process with connection testing
- **SSL Support**: Configurable SSL certificate validation
- **API Token Authentication**: Secure authentication using Proxmox API tokens
- **Multi-node Support**: Automatic discovery and management of cluster nodes

## 📋 Requirements

- **Proxmox VE** server (version 6.0 or higher)
- **API Token** with appropriate permissions
- **Network connectivity** between Homey and Proxmox server
- **Homey** with firmware 12.3.0 or higher

## 🛠 Installation

### From Homey App Store
1. Open the Homey app
2. Go to **Apps** → **App Store**
3. Search for "Proxmox VE"
4. Install the app

### Manual Installation
1. Clone this repository
2. Use Homey CLI to install:
   ```bash
   homey app install
   ```

## ⚙️ Setup

### 1. Create API Token in Proxmox VE
1. Log into your Proxmox web interface
2. Go to **Datacenter** → **Permissions** → **API Tokens**
3. Create a new token with appropriate permissions:
   - **User**: `root@pam` or create a dedicated user
   - **Token ID**: e.g., `homey@pve!mytoken`
   - **Privilege Separation**: Enable for security
   - **Expire**: Set appropriate expiration date

### 2. Add Device in Homey
1. Open Homey app
2. Go to **Devices** → **Add Device**
3. Search for "Proxmox Cluster"
4. Follow the guided pairing process:
   - Enter your Proxmox server hostname/IP
   - Enter username and API token credentials
   - Test the connection
   - Name your device

### 3. Configure Settings
- **Polling Interval**: Set update frequency (30 seconds to 10 minutes)
- **SSL Validation**: Enable/disable based on your setup
- **Debug Logging**: Enable for troubleshooting

## 🎯 Usage

### Device Capabilities
- **measure_node_count**: Number of nodes in cluster
- **measure_vm_count**: Number of running VMs
- **measure_lxc_count**: Number of running containers
- **alarm_connection_fallback**: Connection status alarm
- **status_connected_host**: Currently connected host

### Flow Cards

#### Actions
- **Start VM**: Start a virtual machine
- **Stop VM**: Stop a virtual machine
- **Shutdown VM**: Gracefully shutdown a virtual machine

#### Conditions
- **VM is running**: Check if a specific VM is running

### Node Devices
Individual nodes are automatically discovered and added as separate devices with:
- **measure_cpu_usage_perc**: CPU usage percentage
- **measure_memory_usage_perc**: Memory usage percentage
- **alarm_node_status**: Node online/offline status

## 🔧 Configuration

### SSL Certificates
If your Proxmox server uses self-signed certificates:
1. Enable "Allow Self-Signed Certificates" in device settings
2. ⚠️ **Security Warning**: This reduces security but may be necessary for local setups

### Polling Intervals
- **Cluster**: 5 minutes (default) - for overall cluster statistics
- **Nodes**: 1 minute (default) - for detailed node monitoring
- **Disabled**: Set to 0 to disable automatic polling

## 🐛 Troubleshooting

### Connection Issues
1. **Check network connectivity** between Homey and Proxmox server
2. **Verify API token permissions** in Proxmox
3. **Check SSL certificate settings** if using HTTPS
4. **Review Homey logs** for detailed error messages

### Common Problems
- **"Connection failed"**: Check hostname/IP and network connectivity
- **"Authentication failed"**: Verify username and API token
- **"SSL certificate error"**: Enable self-signed certificates or fix SSL setup

### Debug Mode
Enable debug logging in device settings for detailed troubleshooting information.

## 📚 API Reference

### Proxmox VE API
This app uses the Proxmox VE REST API v2. Required endpoints:
- `/api2/json/version` - Version information
- `/api2/json/cluster/status` - Cluster status
- `/api2/json/nodes/{node}/status` - Node status
- `/api2/json/nodes/{node}/qemu` - VM information
- `/api2/json/nodes/{node}/lxc` - Container information

### Required Permissions
- **Sys.Audit** - Read system information
- **VM.PowerMgmt** - VM power management
- **VM.Config.Disk** - VM configuration (if needed)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Setup
1. Clone the repository
2. Install dependencies: `npm install`
3. Use Homey CLI for development: `homey app run`

### Code Style
- Follow Homey SDK v3 guidelines
- Use ESLint for code formatting
- Add comments for complex logic
- Test thoroughly before submitting

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Athom** for the Homey platform and SDK
- **Proxmox** for the excellent virtualization platform
- **Community** for feedback and suggestions

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/kay-arne/HomeyApps/issues)
- **Homey Community**: [Homey Community Forum](https://community.homey.app/)
- **GitHub**: [kay-arne](https://github.com/kay-arne)

## 🔗 Links

- [Homey App Store](https://apps.developer.homey.app/apps/app/com.proxmox.proxmoxve/build/5)
- [Proxmox VE Documentation](https://pve.proxmox.com/wiki/Main_Page)
- [Homey SDK Documentation](https://apps.developer.homey.app/)

---

**Made with ❤️ for the Homey community**