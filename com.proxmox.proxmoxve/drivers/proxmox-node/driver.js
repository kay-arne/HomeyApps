'use strict';

const Homey = require('homey');
const fetch = require('node-fetch'); // node-fetch@2
const https = require('https');
const crypto = require('crypto'); // For pairing temporary ID

// Driver for individual Proxmox Node devices
module.exports = class ProxmoxNodeDriver extends Homey.Driver {

  // Driver initialization: Register flow handlers once
  async onInit() {
    this.log('ProxmoxNodeDriver initializing...');
    this.registerFlowHandlers();
    this.log('ProxmoxNodeDriver initialized and Flow handlers registered.');
  }

  // Handles the multi-step pairing process (combined list)
  async onPair(session) {
    this.log(`NodeDriver: onPair session started.`);
    try {
      session.setHandler('show', async (viewId) => { this.log(`NodeDriver: Pairing view shown: ${viewId}`); });
      session.setHandler('list_devices', async (data) => {
        this.log(`NodeDriver: list_devices handler called.`);
        try {
          // Step 1: Get all configured cluster devices
          let clusterDevices = [];
          try {
            const clusterDriver = this.homey.drivers.getDriver('proxmox-cluster');
            clusterDevices = clusterDriver.getDevices();
            this.log(`NodeDriver: Found ${clusterDevices.length} cluster devices.`);
          } catch (driverError) { throw new Error('Could not retrieve cluster devices.'); }
          if (clusterDevices.length === 0) { throw new Error(JSON.stringify({ en: 'No Proxmox Cluster devices configured yet.', nl: 'Nog geen Proxmox Cluster apparaten geconfigureerd.' })); }

          // Step 2: Fetch nodes from ALL clusters in parallel
          this.log('NodeDriver: Fetching nodes from all clusters...');
          const nodeFetchPromises = clusterDevices.map(clusterDevice =>
            this._fetchNodesForCluster(clusterDevice) // Pass device object
              .catch(error => {
                this.error(`NodeDriver: Failed to fetch nodes for cluster ${clusterDevice.getName()}:`, error.message);
                return []; // Return empty list on error for this cluster
              })
          );
          const resultsPerCluster = await Promise.all(nodeFetchPromises);

          // Step 3: Combine and filter nodes
          const allDiscoveredNodes = resultsPerCluster.flat();
          const existingNodeDevices = this.getDevices();
          const existingNodeIds = existingNodeDevices.map(device => device.getData().id);
          const nodesToAdd = allDiscoveredNodes.filter(node => !existingNodeIds.includes(node.data.id));
          this.log(`NodeDriver: Returning ${nodesToAdd.length} unpaired node(s).`);

          // Step 4: Return formatted list
          return nodesToAdd.map(node => {
            const clusterDevice = clusterDevices.find(cd => cd.getData().id === node.data.serverId);
            const clusterName = clusterDevice ? clusterDevice.getName() : 'Unknown';
            return {
              ...node,
              name: `${node.name} (@${clusterName})` // Add cluster name for clarity
            };
          });
        } catch (handlerError) {
          this.error('NodeDriver: Error inside list_devices handler:', handlerError);
          throw handlerError; // Propagate error to UI
        }
      });

      // Handler after nodes are selected
      session.setHandler('list_all_nodes.done', async (selectedListData) => {
        this.log(`NodeDriver: list_all_nodes.done handler triggered. Selected nodes:`, selectedListData.map(d => d.name));
        return true; // Finalize pairing
      });

    } catch (registrationError) {
      this.error('NodeDriver: CRITICAL Error during handler registration in onPair:', registrationError);
    }
  }

  // Helper function to fetch nodes for a specific cluster device object
  async _fetchNodesForCluster(clusterDevice) {
    const discoveredNodes = [];
    if (!clusterDevice) return discoveredNodes;

    const clusterDeviceId = clusterDevice.getData().id;
    const clusterDeviceName = clusterDevice.getName();
    this.log(`NodeDriver: Fetching nodes via cluster: ${clusterDeviceName}`);

    try {
      // Use the cluster device's public API call method (ensure it's accessible or replicate logic)
      // Assuming clusterDevice has a method _executeApiCallWithFallback
      const nodesData = await clusterDevice._executeApiCallWithFallback('/api2/json/nodes');

      if (Array.isArray(nodesData?.data)) {
        nodesData.data.forEach(node => {
          if (node.node && node.status === 'online') {
            this.log(`NodeDriver: Mapping online node: ${node.node} from cluster ${clusterDeviceName}`);
            discoveredNodes.push({
              name: node.node, // Original node name
              data: {
                id: node.node, // Node name as the unique ID
                serverId: clusterDeviceId // Link to the cluster device
              },
              // Define capabilities for the node device being added
              capabilities: ['measure_memory_usage_perc', 'measure_cpu_usage_perc', 'alarm_node_status'],
              icon: "/assets/nodes.svg",
            });
          } // else { log skipping }
        });
      }
    } catch (error) {
      this.error(`NodeDriver: Error fetching nodes for cluster ${clusterDeviceName}:`, error);
      // Don't throw, just return empty list for this cluster
    }
    return discoveredNodes;
  }


  // === FLOW CARD HANDLERS (Registered on Driver) ===

  // Registers listeners for Flow cards associated with THIS driver
  registerFlowHandlers() {
    this.log(`Registering node driver flow cards...`);
    try {
      // Register Shutdown Node Action
      const shutdownNodeAction = this.homey.flow.getActionCard('shutdown_node');
      if (shutdownNodeAction) {
        // Pass action name 'shutdown' using .bind()
        shutdownNodeAction.registerRunListener(this.onFlowActionPower.bind(this, 'shutdown'));
        this.log(`- Run listener for shutdown_node registered.`);
      } else { this.error('Could not find flow action card: shutdown_node'); }

      // Register Stop Node Action
      const stopNodeAction = this.homey.flow.getActionCard('stop_node');
      if (stopNodeAction) {
        // Pass action name 'stop' using .bind()
        stopNodeAction.registerRunListener(this.onFlowActionPower.bind(this, 'stop'));
        this.log(`- Run listener for stop_node registered.`);
      } else { this.error('Could not find flow action card: stop_node'); }

    } catch (error) {
      this.error('CRITICAL ERROR during Node Flow registration:', error);
    }
  }

  // Generic handler for node power actions, called by the listeners
  // Receives 'action' via .bind() and 'args' (containing args.device) from Homey
  async onFlowActionPower(action, args, state) {
    const nodeDevice = args.device; // The specific ProxmoxNodeDevice instance
    if (!nodeDevice) {
      this.error(`Flow action ${action}_node triggered without device context.`);
      throw new Error(JSON.stringify({ en: 'Device context missing.', nl: 'Apparaat context ontbreekt.' }));
    }

    const nodeName = nodeDevice.getData().id;
    this.log(`Flow action ${action}_node triggered FOR node [${nodeName}] (Device: ${nodeDevice.getName()})`);

    try {
      // Delegate the action to the specific device instance
      await nodeDevice.triggerPowerAction(action);
      return true; // Indicate success to Homey Flow

    } catch (error) {
      this.error(`Failed to ${action} node [${nodeName}]:`, error.message);
      // Re-throw the error (should already be translated by device method)
      throw error;
    }
  }

} // End of class ProxmoxNodeDriver
