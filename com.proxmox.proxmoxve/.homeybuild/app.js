'use strict';

const Homey = require('homey');

module.exports = class ProxmoxVeApp extends Homey.App {

  // onInit wordt aangeroepen als de app zelf start.
  async onInit() {
    const appName = this.manifest?.name?.en || this.manifest?.id || 'ProxmoxVeApp';
    this.log(`${appName} is running...`);

    // Initialize app-level settings or configurations if needed
    try {
      // Any app-level initialization can go here
      this.log('App initialization completed successfully');
    } catch (error) {
      this.error('App initialization failed:', error);
      throw error; // Re-throw to prevent app from starting with errors
    }
  }

  // Optional: Handle app-level events
  async onUninit() {
    this.log('Proxmox VE app is shutting down...');
  }

}; // Einde klasse
