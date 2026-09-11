'use strict';

/**
 * Public (unauthenticated on the LAN) webhook routes, meant to be called by a
 * FortiGate "Automation Stitch" (System > Automation) whose action is
 * "Webhook", pointed at this Homey. This is the recommended way to get
 * near-real-time security-event and disconnect alerts, instead of polling
 * FortiGate's log API. See README.md "Push alerts via FortiGate Automation".
 *
 * Every request must include the per-FortiGate `secret` that was generated
 * when you paired the FortiGate device (shown in that device's settings),
 * so a request can be matched to the right paired FortiGate and so random
 * LAN traffic can't spoof events.
 *
 * Full URL from the FortiGate's point of view:
 *   http://<homey-local-ip>/api/app/com.fortinet.fortigate/webhook/security-event
 *   http://<homey-local-ip>/api/app/com.fortinet.fortigate/webhook/connectivity-event
 */

module.exports = {
  async webhookSecurityEvent({ homey, body }) {
    const app = homey.app;
    const fortigate = app.findFortiGateDeviceBySecret(body && body.secret);
    if (!fortigate) return { ok: false, error: 'unknown or missing secret' };

    await app.triggerSecurityEvent.trigger(fortigate, {
      type: String((body && body.type) || 'unknown'),
      severity: String((body && body.severity) || 'unknown'),
      message: String((body && body.message) || ''),
      srcip: String((body && body.srcip) || ''),
      dstip: String((body && body.dstip) || ''),
    });

    return { ok: true };
  },

  async webhookConnectivityEvent({ homey, body }) {
    const app = homey.app;
    const fortigate = app.findFortiGateDeviceBySecret(body && body.secret);
    if (!fortigate) return { ok: false, error: 'unknown or missing secret' };

    const device = app.findNetworkDeviceById(body && body.id);
    if (!device) return { ok: false, error: `no paired device with id ${body && body.id}` };

    const goingOffline = String((body && body.state) || '').toLowerCase() === 'offline';
    if (typeof device.setConnectivity === 'function') {
      await device.setConnectivity(!goingOffline, (body && body.reason) || 'FortiGate automation webhook');
    }

    return { ok: true };
  },
};
