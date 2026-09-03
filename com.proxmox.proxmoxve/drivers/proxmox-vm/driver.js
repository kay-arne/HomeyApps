'use strict';

const Homey = require('homey');

// Driver for individual Proxmox VM/Container devices
module.exports = class ProxmoxVmDriver extends Homey.Driver {

  async onInit() {
    this.log(this.homey.__('driver.vm_driver_initializing'));
  }

  // Handles the pairing process (combined list, same shape as proxmox-node)
  async onPair(session) {
    this.log(this.homey.__('driver.vm_onpair_started'));
    try {
      session.setHandler('list_devices', async () => {
        this.log(this.homey.__('driver.vm_list_devices'));
        try {
          // Step 1: Get all configured cluster devices
          let clusterDevices = [];
          try {
            const clusterDriver = this.homey.drivers.getDriver('proxmox-cluster');
            clusterDevices = clusterDriver.getDevices();
          } catch (driverError) {
            throw new Error('Could not retrieve cluster devices.');
          }
          if (clusterDevices.length === 0) {
            throw new Error(this.homey.__('error.no_cluster_devices'));
          }

          // Step 2: Fetch VMs/Containers from ALL clusters in parallel
          const fetchPromises = clusterDevices.map((clusterDevice) => this._fetchVmsForCluster(clusterDevice)
            .catch((error) => {
              this.error(this.homey.__('driver.vm_fetch_failed', { s: clusterDevice.getName(), s2: error.message }));
              return [];
            }));
          const resultsPerCluster = await Promise.all(fetchPromises);

          // Step 3: Combine and filter out already-paired devices
          const allDiscovered = resultsPerCluster.flat();
          const existingIds = this.getDevices().map((device) => device.getData().id);
          const toAdd = allDiscovered.filter((vm) => !existingIds.includes(vm.data.id));
          this.log(this.homey.__('driver.vm_returning', { s: toAdd.length }));

          // Step 4: Return formatted list
          return toAdd.map((vm) => {
            const clusterDevice = clusterDevices.find((cd) => cd.getData().id === vm.data.serverId);
            const clusterName = clusterDevice ? clusterDevice.getName() : 'Unknown';
            return {
              ...vm,
              name: `${vm.name} (@${clusterName})`,
            };
          });
        } catch (handlerError) {
          this.error(this.homey.__('driver.vm_list_devices_error'), handlerError);
          throw handlerError;
        }
      });

    } catch (registrationError) {
      this.error(this.homey.__('driver.vm_critical_error_pair'), registrationError);
    }
  }

  // Helper function to fetch VMs/Containers for a specific cluster device object
  async _fetchVmsForCluster(clusterDevice) {
    const discovered = [];
    if (!clusterDevice) return discovered;

    const clusterDeviceId = clusterDevice.getData().id;

    try {
      const res = await clusterDevice._executeApiCallWithFallback('/api2/json/cluster/resources');

      if (Array.isArray(res?.data)) {
        res.data.forEach((r) => {
          if (r.type !== 'qemu' && r.type !== 'lxc') return;
          const device = {
            name: r.name || `${r.type} ${r.vmid}`,
            data: {
              id: `${r.type}-${r.vmid}-${clusterDeviceId}`,
              vmid: r.vmid,
              type: r.type,
              serverId: clusterDeviceId,
            },
            capabilities: ['onoff', 'measure_cpu_usage_perc', 'measure_memory_usage_perc', 'measure_uptime', 'measure_network_in', 'measure_network_out'],
          };
          if (r.type === 'lxc') {
            // Per-device pairing icon paths are resolved relative to this driver's own
            // assets/ folder (NOT the top-level app assets/) - qemu devices use the
            // driver's own default icon.svg (already the VM/desktop icon), lxc devices
            // override to drivers/proxmox-vm/assets/container.svg.
            device.icon = 'container.svg';
            // Actual used disk space is only reliably reported by Proxmox for LXC
            // containers (via a per-device /status/current call) - QEMU VMs need the guest
            // agent for this, which isn't assumed to be installed, so this capability is
            // intentionally LXC-only rather than present-but-always-empty on VM devices too.
            device.capabilities.push('measure_disk_usage_perc');
          }
          discovered.push(device);
        });
      }
    } catch (error) {
      this.error(this.homey.__('driver.vm_fetch_error', { s: clusterDevice.getName(), s2: error.message }));
    }
    return discovered;
  }

}; // End of class ProxmoxVmDriver
