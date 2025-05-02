'use strict';

const Homey = require('homey');
const crypto = require('crypto'); // For pairing temporary ID

// Driver for the Proxmox Cluster connection devices
module.exports = class ProxmoxClusterDriver extends Homey.Driver {

  // Driver initialization: Register flow handlers once
  async onInit() {
    this.log('ProxmoxClusterDriver initializing...');
    this.registerFlowHandlers();
    this.log('ProxmoxClusterDriver initialized and Flow handlers registered.');
  }

  // Pairing logic (remains the same)
  async onPairListDevices() {
    this.log('ProxmoxClusterDriver: onPairListDevices called');
    const uniqueSessionId = crypto.randomUUID();
    const deviceObjectForPairing = {
      data: { id: `new-proxmox-cluster-${uniqueSessionId}` },
      name: "New Proxmox Cluster", // Static name for pairing list
      settings: { hostname: '', username: 'root@pam', api_token_id: '', api_token_secret: '' },
      capabilities: [ 'measure_node_count', 'measure_vm_count', 'measure_lxc_count', 'alarm_connection_fallback', 'status_connected_host' ],
      icon: "/cluster.svg",
    };
    this.log(`Presenting generic "Add New Cluster" option with temporary data ID: ${deviceObjectForPairing.data.id}`);
    return [deviceObjectForPairing];
  }

  // === FLOW CARD HANDLERS (Now on Driver level) ===

  // Registers listeners ONCE for the Flow cards associated with this driver type
  registerFlowHandlers() {
    this.log(`Registering cluster driver flow cards...`);
    try {
      // Helper to register listeners for a card
      const registerCard = (type, id, runListener, autocompleteListener = null) => {
        const card = this.homey.flow[`get${type}Card`](id);
        if (card) {
          // Run listeners are registered on the driver, handler receives args.device
          if (runListener) card.registerRunListener(runListener.bind(this));
          const arg = card.getArgument('target_vm');
          if (arg && autocompleteListener) {
            // Autocomplete listener registered on driver, handler needs context
            arg.registerAutocompleteListener(autocompleteListener.bind(this));
          } else if (autocompleteListener && !arg) {
             this.error(`Missing argument 'target_vm' on card '${id}'`);
          }
          this.log(`- Listeners for ${type.toLowerCase()} card '${id}' registered.`);
        } else {
          this.error(`Could not find flow ${type.toLowerCase()} card: ${id}`);
        }
      };

      // Register all cards - handlers refer to methods on THIS driver class
      registerCard('Action', 'start_vm', this.onFlowActionStartVm, this.handleFlowArgumentAutocomplete);
      registerCard('Action', 'stop_vm', this.onFlowActionStopVm, this.handleFlowArgumentAutocomplete);
      registerCard('Action', 'shutdown_vm', this.onFlowActionShutdownVm, this.handleFlowArgumentAutocomplete);
      registerCard('Condition', 'vm_is_running', this.onFlowConditionIsRunning, this.handleFlowArgumentAutocomplete);

    } catch (error) { this.error('CRITICAL ERROR during Flow registration:', error); }
  }

  // Autocomplete handler - fetches VMs/LXCs from the relevant cluster device
  // NOTE: This implementation might show combined results if context isn't passed reliably.
  // A more robust solution might require changes to how Homey passes context here.
  // For now, it iterates through all cluster devices if context is unclear.
  async handleFlowArgumentAutocomplete(query, args) {
      // Try to get the specific device instance if Homey provides it in args
      const specificDevice = args?.device;
      const results = [];

      if (specificDevice) {
          // If we have the specific device, get results only from it
          this.log(`Handling autocomplete for specific Cluster Device: [${specificDevice.getName()}], Query: "${query}"`);
          try {
              // Delegate to a method on the device instance
              const deviceResults = await specificDevice.getAutocompleteResults(query);
              results.push(...deviceResults);
          } catch (error) { this.error(`Autocomplete API error for [${specificDevice.getName()}]:`, error.message); }
      } else {
          // Fallback: If no specific device context, query all cluster devices (less ideal)
          this.log(`Handling autocomplete GLOBALLY (no specific device context), Query: "${query}"`);
          const clusterDevices = this.getDevices();
          for (const device of clusterDevices) {
              try {
                  const deviceResults = await device.getAutocompleteResults(query);
                  // Add cluster name to distinguish results
                  results.push(...deviceResults.map(r => ({ ...r, name: `${r.name} (@${device.getName()})` })));
              } catch (deviceError) { this.error(`Autocomplete API error for cluster [${device.getName()}]:`, deviceError.message); }
          }
      }
      this.log(`Returning ${results.length} total autocomplete results.`);
      return results;
  }


  // --- Flow Run/Condition Listeners (Delegate to the specific device instance) ---

  // Generic handler for start/stop/shutdown actions
  async _handleVmAction(args, action) {
    const clusterDevice = args.device; // The specific ProxmoxClusterDevice instance
    if (!clusterDevice || typeof clusterDevice.executeVmAction !== 'function') {
      this.error(`Flow action ${action} triggered without valid device context or method.`);
      throw new Error(JSON.stringify({ en: 'Device context missing or invalid.', nl: 'Apparaat context ontbreekt of is ongeldig.' }));
    }
    // Delegate the action to the specific device instance
    return clusterDevice.executeVmAction(args, action);
  }

  // Specific run listeners calling the generic handler
  async onFlowActionStartVm(args, state) { return this._handleVmAction(args, 'start'); }
  async onFlowActionStopVm(args, state) { return this._handleVmAction(args, 'stop'); }
  async onFlowActionShutdownVm(args, state) { return this._handleVmAction(args, 'shutdown'); }

  // Run listener for VM/LXC Is Running Condition
  async onFlowConditionIsRunning(args, state) {
    const clusterDevice = args.device; // The specific ProxmoxClusterDevice instance
    if (!clusterDevice || typeof clusterDevice.checkVmStatus !== 'function') {
      this.error(`Flow condition vm_is_running triggered without valid device context or method.`);
      throw new Error(JSON.stringify({ en: 'Device context missing or invalid.', nl: 'Apparaat context ontbreekt of is ongeldig.' }));
    }
    // Delegate the check to the specific device instance
    return clusterDevice.checkVmStatus(args);
  }

} // End of class ProxmoxClusterDriver
