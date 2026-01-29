'use strict';

const Homey = require('homey');


// Driver for individual Proxmox Node devices
module.exports = class ProxmoxNodeDriver extends Homey.Driver {

  // Driver initialization: Register flow handlers once
  async onInit() {
    this.log(this.homey.__('driver.node_driver_initializing'));
    this.registerFlowHandlers();
    this.log(this.homey.__('driver.node_driver_initialized'));
  }

  // Handles the multi-step pairing process (combined list)
  async onPair(session) {
    this.log(this.homey.__('driver.node_onpair_started'));
    try {
      session.setHandler('show', async (viewId) => {
        this.log(this.homey.__('driver.node_pairing_view', { s: viewId }));
      });
      session.setHandler('list_devices', async (data) => {
        this.log(this.homey.__('driver.node_list_devices'));
        try {
          // Step 1: Get all configured cluster devices
          let clusterDevices = [];
          try {
            const clusterDriver = this.homey.drivers.getDriver('proxmox-cluster');
            clusterDevices = clusterDriver.getDevices();
            this.log(this.homey.__('driver.node_found_clusters', { s: clusterDevices.length }));
          } catch (driverError) {
            throw new Error('Could not retrieve cluster devices.');
          }
          if (clusterDevices.length === 0) {
            throw new Error(this.homey.__('error.no_cluster_devices'));
          }

          // Step 2: Fetch nodes from ALL clusters in parallel
          this.log(this.homey.__('driver.node_fetching'));
          const nodeFetchPromises = clusterDevices.map((clusterDevice) => this._fetchNodesForCluster(clusterDevice) // Pass device object
            .catch((error) => {
              this.error(this.homey.__('driver.node_fetch_failed', { s: clusterDevice.getName(), s2: error.message }));
              return []; // Return empty list on error for this cluster
            }));
          const resultsPerCluster = await Promise.all(nodeFetchPromises);

          // Step 3: Combine and filter nodes
          const allDiscoveredNodes = resultsPerCluster.flat();
          const existingNodeDevices = this.getDevices();
          const existingNodeIds = existingNodeDevices.map((device) => device.getData().id);
          const nodesToAdd = allDiscoveredNodes.filter((node) => !existingNodeIds.includes(node.data.id));
          this.log(this.homey.__('driver.node_returning', { s: nodesToAdd.length }));

          // Step 4: Return formatted list
          return nodesToAdd.map((node) => {
            const clusterDevice = clusterDevices.find((cd) => cd.getData().id === node.data.serverId);
            const clusterName = clusterDevice ? clusterDevice.getName() : 'Unknown';
            return {
              ...node,
              name: `${node.name} (@${clusterName})`, // Add cluster name for clarity
            };
          });
        } catch (handlerError) {
          this.error(this.homey.__('driver.node_list_devices_error'), handlerError);
          throw handlerError; // Propagate error to UI
        }
      });

      // Handler after nodes are selected
      session.setHandler('list_all_nodes.done', async (selectedListData) => {
        this.log(this.homey.__('driver.node_list_done', { s: selectedListData.map((d) => d.name) }));
        return true; // Finalize pairing
      });

    } catch (registrationError) {
      this.error(this.homey.__('driver.node_critical_error_pair'), registrationError);
    }
  }

  // Helper function to fetch nodes for a specific cluster device object
  async _fetchNodesForCluster(clusterDevice) {
    const discoveredNodes = [];
    if (!clusterDevice) return discoveredNodes;

    const clusterDeviceId = clusterDevice.getData().id;
    const clusterDeviceName = clusterDevice.getName();
    this.log(this.homey.__('driver.node_fetching_via', { s: clusterDeviceName }));

    try {
      // Use the cluster device's public API call method (ensure it's accessible or replicate logic)
      // Assuming clusterDevice has a method _executeApiCallWithFallback
      const nodesData = await clusterDevice._executeApiCallWithFallback('/api2/json/nodes');

      if (Array.isArray(nodesData?.data)) {
        nodesData.data.forEach((node) => {
          if (node.node && node.status === 'online') {
            this.log(this.homey.__('driver.node_mapping', { s: node.node, s2: clusterDeviceName }));
            discoveredNodes.push({
              name: node.node, // Original node name
              data: {
                id: node.node, // Node name as the unique ID
                serverId: clusterDeviceId, // Link to the cluster device
              },
              // Define capabilities for the node device being added
              capabilities: ['measure_memory_usage_perc', 'measure_cpu_usage_perc', 'alarm_node_status'],
              icon: '/assets/nodes.svg',
            });
          } // else { log skipping }
        });
      }
    } catch (error) {
      this.error(this.homey.__('driver.node_fetch_error', { s: clusterDeviceName, s2: error }));
      // Don't throw, just return empty list for this cluster
    }
    return discoveredNodes;
  }

  // === FLOW CARD HANDLERS (Registered on Driver) ===

  // Registers listeners for Flow cards associated with THIS driver
  registerFlowHandlers() {
    this.log(this.homey.__('driver.node_registering_flow'));
    try {
      // Register Shutdown Node Action
      const shutdownNodeAction = this.homey.flow.getActionCard('shutdown_node');
      if (shutdownNodeAction) {
        // Pass action name 'shutdown' using .bind()
        shutdownNodeAction.registerRunListener(this.onFlowActionPower.bind(this, 'shutdown'));
        this.log(this.homey.__('driver.node_shutdown_registered'));
      } else {
        this.error(this.homey.__('driver.node_flow_not_found', { s: 'shutdown_node' }));
      }

      // Register Stop Node Action
      const stopNodeAction = this.homey.flow.getActionCard('stop_node');
      if (stopNodeAction) {
        // Pass action name 'stop' using .bind()
        stopNodeAction.registerRunListener(this.onFlowActionPower.bind(this, 'stop'));
        this.log(this.homey.__('driver.node_stop_registered'));
      } else {
        this.error(this.homey.__('driver.node_flow_not_found', { s: 'stop_node' }));
      }

      // Register Node is Online Condition
      const nodeOnlineCondition = this.homey.flow.getConditionCard('node_is_online');
      if (nodeOnlineCondition) {
        nodeOnlineCondition.registerRunListener(async (args, state) => {
          const nodeDevice = args.device;
          if (!nodeDevice) return false;

          // Force real-time check with 3s timeout
          try {
            await nodeDevice.updateNodeStatus({ timeout: 3000 });
          } catch (e) {
            // Ignore error here, updateNodeStatus handles alarms internally
          }

          // Returns TRUE if alarm is FALSE (meaning online)
          return !nodeDevice.getCapabilityValue('alarm_node_status');
        });
        this.log(this.homey.__('driver.node_condition_registered'));
      } else {
        this.error(this.homey.__('driver.node_flow_not_found', { s: 'node_is_online' }));
      }

    } catch (error) {
      this.error(this.homey.__('driver.node_critical_error_flow'), error);
    }
  }

  // Generic handler for node power actions, called by the listeners
  // Receives 'action' via .bind() and 'args' (containing args.device) from Homey
  async onFlowActionPower(action, args, state) {
    const nodeDevice = args.device; // The specific ProxmoxNodeDevice instance
    if (!nodeDevice) {
      this.error(this.homey.__('driver.node_flow_action_no_context', { s: action }));
      throw new Error(this.homey.__('error.device_context_missing'));
    }

    const nodeName = nodeDevice.getData().id;
    this.log(this.homey.__('driver.node_flow_triggered', { s: action, s2: nodeName, s3: nodeDevice.getName() }));

    try {
      // Delegate the action to the specific device instance
      await nodeDevice.triggerPowerAction(action);
      return true; // Indicate success to Homey Flow

    } catch (error) {
      this.error(this.homey.__('driver.node_action_failed', { s: action, s2: nodeName }), error.message);
      // Re-throw the error (should already be translated by device method)
      throw error;
    }
  }

}; // End of class ProxmoxNodeDriver
