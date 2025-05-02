'use strict';

const Homey = require('homey');

module.exports = class ProxmoxVeApp extends Homey.App {

  // onInit wordt aangeroepen als de app zelf start.
  async onInit() {
    const appName = this.manifest?.name?.en || this.manifest?.id || 'ProxmoxVeApp';
    this.log(`${appName} is running...`);
  }

} // Einde klasse