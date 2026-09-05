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

    this._registerWidgetDevicePickers();
  }

  // Widgets pick a device via a custom "autocomplete" setting rather than Homey's native
  // "devices" picker. The native picker's Homey.getDeviceIds() returns a platform-wide device
  // ID - a completely different, unrelated ID space from this app's own pairing `data.id`
  // (confirmed by testing on a real Homey) - and translating that back would need the broad
  // homey:manager:api permission plus the Homey Web API. With our own autocomplete listener, we
  // control the returned value ourselves, so it can just be our own data.id directly,
  // resolvable the normal way via homey.drivers - no extra permission needed.
  _registerWidgetDevicePickers() {
    const registerDevicePicker = (widgetId, driverId) => {
      try {
        const widget = this.homey.dashboards.getWidget(widgetId);
        widget.registerSettingAutocompleteListener('device', async (query) => {
          const q = (query || '').toLowerCase();
          return this.homey.drivers.getDriver(driverId).getDevices()
            .filter((d) => d.getName().toLowerCase().includes(q))
            .map((d) => ({ name: d.getName(), id: d.getData().id }));
        });
        this.log(`Registered device picker for widget '${widgetId}'`);
      } catch (error) {
        this.error(`Failed to register device picker for widget '${widgetId}':`, error);
      }
    };

    registerDevicePicker('cluster-overview', 'proxmox-cluster');
    registerDevicePicker('vm-control', 'proxmox-cluster');
    registerDevicePicker('node-status', 'proxmox-cluster');
    registerDevicePicker('backup-status', 'proxmox-cluster');
  }

  // Optional: Handle app-level events
  async onUninit() {
    this.log('Proxmox VE app is shutting down...');
  }

}; // Einde klasse
