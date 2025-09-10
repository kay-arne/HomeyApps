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


  // Custom pairing logic according to SDK v3
  async onPair(session) {
    this.log('ProxmoxClusterDriver: onPair session started');
    
    // Initialize session data
    this.clusterInfo = null;
    
    // Start with the first view
    await session.showView('connection_setup');
    
    // Handle connection setup and testing - according to SDK documentation
    session.setHandler('connection_setup', async function (data) {
      
      const { hostname, username, api_token_id, api_token_secret, allow_self_signed_certs } = data;
      
      // Validate input
      if (!hostname || !username || !api_token_id || !api_token_secret) {
        return {
          success: false,
          error: 'All fields are required'
        };
      }

      // Test connection
      try {
        const testResult = await this.testProxmoxConnection({
          hostname,
          username,
          api_token_id,
          api_token_secret,
          allow_self_signed_certs: allow_self_signed_certs || false
        });

        if (testResult.success) {
          const nodeNames = testResult.clusterInfo.nodes.map(node => node.name).join(', ');
          
          // Store cluster info in session for later retrieval
          this.clusterInfo = testResult.clusterInfo;

          return {
            success: true,
            clusterInfo: testResult.clusterInfo,
            message: `Connection successful! Found ${testResult.clusterInfo.nodes.length} nodes in cluster: ${nodeNames}`
          };
        } else {
          return {
            success: false,
            error: testResult.error
          };
        }
      } catch (error) {
        this.error('Connection test exception:', error.message);
        return {
          success: false,
          error: error.message || 'Connection test failed'
        };
      }
    }.bind(this));

    // Handle cluster info retrieval
    session.setHandler('get_cluster_info', async function () {
      return this.clusterInfo || null;
    }.bind(this));

  }


  // Test Proxmox connection during pairing
  async testProxmoxConnection(credentials) {
    const fetch = require('node-fetch');
    const https = require('https');
    
    try {
      // Create HTTPS agent
      const httpsAgent = new https.Agent({
        rejectUnauthorized: !credentials.allow_self_signed_certs,
        timeout: 10000
      });

      // Test basic connection
      const url = `https://${credentials.hostname}:8006/api2/json/version`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `PVEAPIToken=${credentials.username}!${credentials.api_token_id}=${credentials.api_token_secret}`,
          'Accept': 'application/json',
          'User-Agent': 'Homey-ProxmoxVE/1.0'
        },
        agent: httpsAgent,
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(JSON.stringify({
          en: `Connection failed: HTTP ${response.status}`,
          nl: `Verbinding mislukt: HTTP ${response.status}`
        }));
      }

      // Get cluster information
      const clusterStatusUrl = `https://${credentials.hostname}:8006/api2/json/cluster/status`;
      const clusterResponse = await fetch(clusterStatusUrl, {
        method: 'GET',
        headers: {
          'Authorization': `PVEAPIToken=${credentials.username}!${credentials.api_token_id}=${credentials.api_token_secret}`,
          'Accept': 'application/json',
          'User-Agent': 'Homey-ProxmoxVE/1.0'
        },
        agent: httpsAgent,
        timeout: 10000
      });

      if (!clusterResponse.ok) {
        throw new Error(JSON.stringify({
          en: `Failed to get cluster information: HTTP ${clusterResponse.status}`,
          nl: `Kon cluster informatie niet ophalen: HTTP ${clusterResponse.status}`
        }));
      }

      const clusterData = await clusterResponse.json();
      const nodes = clusterData.data?.filter(item => item.type === 'node') || [];


        return {
          success: true,
          clusterInfo: {
            nodes: nodes.map(node => ({
              name: node.name,
              ip: node.ip,
              online: node.online === 1
            })),
            totalNodes: nodes.length,
            onlineNodes: nodes.filter(node => node.online === 1).length
          }
        };

    } catch (error) {
      this.error('Connection test error:', error);
      return {
        success: false,
        error: error.message || JSON.stringify({
          en: 'Connection test failed',
          nl: 'Verbindingstest mislukt'
        })
      };
    }
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

    } catch (error) { 
      this.error('CRITICAL ERROR during Flow registration:', error); 
      throw error; // Re-throw to prevent app from starting with broken flow cards
    }
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
