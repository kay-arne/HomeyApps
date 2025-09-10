'use strict';

const Homey = require('homey');
const fetch = require('node-fetch'); // Ensure node-fetch@2 is installed
const https = require('https');

// Represents the paired Proxmox Cluster connection device
module.exports = class ProxmoxClusterDevice extends Homey.Device {
  updateIntervalId = null; // Stores the ID for the polling timer for this instance
  healthCheckIntervalId = null; // New: Proactive health monitoring
  requestCache = new Map(); // Cache for API responses
  pendingRequests = new Map(); // Deduplication for concurrent requests
  cacheTimeout = 5 * 60 * 1000; // 5 minutes cache TTL
  activeTimeouts = new Set(); // Track active timeouts for cleanup
  connectionHealth = {
    lastSuccessfulCall: null,
    consecutiveFailures: 0,
    totalCalls: 0,
    totalFailures: 0,
    averageResponseTime: 0
  };

  // New: Intelligent host management
  hostManager = {
    primaryHost: null,
    availableHosts: new Map(), // host -> { lastSeen, responseTime, failureCount, status }
    circuitBreakers: new Map(), // host -> { failures, lastFailure, state: 'closed'|'open'|'half-open' }
    preferredHost: null, // Currently best performing host
    lastHealthCheck: 0,
    healthCheckInterval: 30000 // 30 seconds
  };

  // === LIFECYCLE METHODS ===

  async onInit() {
    this.log(`Initializing Enhanced Cluster Device: ${this.getName()} (Homey ID: ${this.getData().id})`);
    try {
      // Clean up any existing cache
      this._cleanupCache();
      this._initializeHostManager();
      
      // Test connection if credentials are provided
      const hostname = this.getSetting('hostname');
      const username = this.getSetting('username');
      const api_token_id = this.getSetting('api_token_id');
      const api_token_secret = this.getSetting('api_token_secret');
      
      if (hostname && username && api_token_id && api_token_secret) {
        this.log('Credentials found, testing connection...');
        const connectionTest = await this.testApiConnection();
        if (connectionTest) {
          this.log('Connection test successful, proceeding with initialization');
        } else {
          this.log('Connection test failed, but continuing with initialization');
        }
      } else {
        this.log('No credentials provided, skipping connection test');
      }
      
      await this.updateStatusAndConnection();
      this.startPolling(); // Start polling, it will manage connection state
      this.startHealthMonitoring(); // New: Start proactive health monitoring
    } catch (error) {
      this.error(`Initialization Error for [${this.getName()}]:`, error);
      const errorMessage = error.message || 'Initialization failed';
      await this.setUnavailable(errorMessage).catch(err => this.error('Failed to set unavailable:', err));
      
      // Ensure capabilities reflect failed state on init error
      try {
        await Promise.all([
          this._updateCapability('alarm_connection_fallback', false),
          this._updateCapability('status_connected_host', this.getSetting('hostname') || 'Unknown')
        ]);
      } catch (capError) {
        this.error('Failed to update capabilities during init error:', capError);
      }
    }
  }

  async onAdded() {
    this.log(`Device added: ${this.getName()}`);
    // Perform an initial status update shortly after adding
    this._createManagedTimeout(async () => {
         await this.updateStatusAndConnection().catch(this.error);
    }, 2000);
   }

  async onSettings({ newSettings, changedKeys }) {
     this.log(`Settings updated for: ${this.getName()}`);
     try {
       let connectionOK = false;
       // If primary hostname changes, reset fallback state immediately
       if (changedKeys.includes('hostname')) {
           this.log('Primary hostname changed, resetting connection state.');
           // No need to store last_successful_host anymore
           await this._updateCapability('alarm_connection_fallback', false);
           await this._updateCapability('status_connected_host', newSettings.hostname);
           connectionOK = await this.testApiConnection(newSettings); // Test only new primary
       } else {
           // For other setting changes, perform a full status update which includes connection check & fallback
           await this.updateStatusAndConnection();
           connectionOK = this.getAvailable(); // Check availability after update attempt
       }

       // Restart polling if interval changed AND connection is currently OK
       if (connectionOK && changedKeys.includes('poll_interval_cluster')) {
          this.log('Polling interval changed, restarting polling.');
          const newIntervalMinutes = parseFloat(newSettings.poll_interval_cluster);
          this.startPolling(isNaN(newIntervalMinutes) ? null : newIntervalMinutes);
       } else if (connectionOK) {
          // Ensure polling is running if connection is OK but interval didn't change
          this.startPolling();
       } else {
          this.stopPolling(); // Stop polling if connection failed
       }
     } catch (error) {
        this.error(`Error processing settings update for [${this.getName()}]:`, error);
     }
   }

   async onRenamed(name) { this.log(`Device renamed: ${this.getName()} to ${name}`); }
   async onDeleted() { 
     this.log(`Enhanced device deleted: ${this.getName()}`); 
     this.stopPolling(); 
     this.stopHealthMonitoring(); // New: Stop health monitoring
     // Clean up cache, pending requests, and timeouts
     this.requestCache.clear();
     this.pendingRequests.clear();
     this._clearAllTimeouts();
   }

  // === POLLING LOGIC ===

  startPolling(intervalMinutesSetting = null) {
    this.stopPolling();
    const pollIntervalMinutes = intervalMinutesSetting ?? parseFloat(this.getSetting('poll_interval_cluster') || '5'); // Default 5 min
    this.log(`Setting polling interval to ${pollIntervalMinutes} minutes for [${this.getName()}]`);
    if (isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
      this.log(`Polling disabled for [${this.getName()}] (interval <= 0).`);
      return;
    }
    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    this.log(`Starting cluster status polling every ${pollIntervalMinutes} minutes for [${this.getName()}]`);
    
    // Add jitter to prevent all devices from polling simultaneously
    const jitter = Math.random() * 30000; // 0-30 seconds jitter
    const initialDelay = jitter;
    
    // Store the interval ID for proper cleanup
    this.updateIntervalId = this.homey.setInterval(async () => {
      // Polling trigger calls the central update function
      await this.updateStatusAndConnection().catch(error => {
          this.error(`Error during scheduled poll check for [${this.getName()}]:`, error);
      });
    }, pollIntervalMs);
    
    // Schedule initial poll with jitter
    this._createManagedTimeout(async () => {
      await this.updateStatusAndConnection().catch(error => {
          this.error(`Error during initial poll check for [${this.getName()}]:`, error);
      });
    }, initialDelay);
  }

  stopPolling() {
    if (this.updateIntervalId) {
      this.homey.clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
      this.log(`Stopped cluster status polling for [${this.getName()}]`);
    }
  }

  // === TIMEOUT MANAGEMENT HELPERS ===

  _createManagedTimeout(callback, delay) {
    const timeoutId = this.homey.setTimeout(async () => {
      this.activeTimeouts.delete(timeoutId);
      try {
        await callback();
      } catch (error) {
        this.error('Error in managed timeout callback:', error);
      }
    }, delay);
    
    this.activeTimeouts.add(timeoutId);
    return timeoutId;
  }

  _clearManagedTimeout(timeoutId) {
    if (this.activeTimeouts.has(timeoutId)) {
      this.homey.clearTimeout(timeoutId);
      this.activeTimeouts.delete(timeoutId);
    }
  }

  _clearAllTimeouts() {
    for (const timeoutId of this.activeTimeouts) {
      this.homey.clearTimeout(timeoutId);
    }
    this.activeTimeouts.clear();
    this.log('Cleared all active timeouts');
  }

  // === ENHANCED HOST MANAGEMENT ===

  _initializeHostManager() {
    const primaryHost = this.getSetting('hostname');
    this.hostManager.primaryHost = primaryHost;
    this.hostManager.preferredHost = primaryHost;
    
    // Initialize primary host in available hosts
    this.hostManager.availableHosts.set(primaryHost, {
      lastSeen: Date.now(),
      responseTime: 0,
      failureCount: 0,
      status: 'unknown'
    });
    
    this.log(`Host manager initialized with primary: ${primaryHost}`);
  }

  // New: Proactive health monitoring of all cluster nodes
  startHealthMonitoring() {
    this.stopHealthMonitoring();
    
    const interval = this.hostManager.healthCheckInterval;
    this.log(`Starting proactive health monitoring every ${interval/1000} seconds`);
    
    this.healthCheckIntervalId = this.homey.setInterval(async () => {
      await this._performHealthCheck().catch(error => {
        this.error('Error during health check:', error);
      });
    }, interval);
    
    // Perform initial health check
    this._createManagedTimeout(() => {
      this._performHealthCheck().catch(this.error);
    }, 5000);
  }

  stopHealthMonitoring() {
    if (this.healthCheckIntervalId) {
      this.homey.clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
      this.log('Stopped proactive health monitoring');
    }
  }

  // New: Comprehensive health check of all cluster nodes
  async _performHealthCheck() {
    const now = Date.now();
    this.hostManager.lastHealthCheck = now;
    
    try {
      // Get current cluster status
      const clusterStatusData = await this._doApiCall(
        this.hostManager.primaryHost, 
        '/api2/json/cluster/status', 
        { method: 'GET', timeout: 10000 }
      );
      
      if (!Array.isArray(clusterStatusData?.data)) {
        this.log('[WARN] Invalid cluster status response during health check');
        return;
      }

      const onlineNodes = clusterStatusData.data.filter(item => 
        item.type === 'node' && item.online === 1 && item.ip
      );

      // Test each online node
      const healthCheckPromises = onlineNodes.map(async (node) => {
        const nodeIp = node.ip;
        const nodeName = node.name;
        
        try {
          const startTime = Date.now();
          await this._doApiCall(nodeIp, '/api2/json/version', { 
            method: 'GET', 
            timeout: 5000 
          });
          const responseTime = Date.now() - startTime;
          
          // Update host status
          this.hostManager.availableHosts.set(nodeIp, {
            lastSeen: now,
            responseTime: responseTime,
            failureCount: 0,
            status: 'healthy',
            nodeName: nodeName
          });
          
          // Reset circuit breaker if it was open
          if (this.hostManager.circuitBreakers.has(nodeIp)) {
            const breaker = this.hostManager.circuitBreakers.get(nodeIp);
            if (breaker.state === 'open' && (now - breaker.lastFailure) > 60000) { // 1 minute
              breaker.state = 'half-open';
              this.log(`Circuit breaker for ${nodeIp} moved to half-open`);
            }
          }
          
          this.log(`Health check OK: ${nodeName} (${nodeIp}) - ${responseTime}ms`);
          
        } catch (error) {
          // Update failure count
          const current = this.hostManager.availableHosts.get(nodeIp) || {
            lastSeen: 0,
            responseTime: 0,
            failureCount: 0,
            status: 'unknown'
          };
          
          current.failureCount++;
          current.status = 'unhealthy';
          current.lastFailure = now;
          
          this.hostManager.availableHosts.set(nodeIp, current);
          
          // Update circuit breaker
          this._updateCircuitBreaker(nodeIp, false);
          
          this.log(`Health check FAILED: ${nodeName} (${nodeIp}) - ${error.message}`);
        }
      });

      await Promise.allSettled(healthCheckPromises);
      
      // Update preferred host based on performance
      this._updatePreferredHost();
      
      // Clean up old/unreachable hosts
      this._cleanupHostManager();
      
    } catch (error) {
      this.error('Health check failed:', error.message);
    }
  }

  // New: Circuit breaker pattern for failed hosts
  _updateCircuitBreaker(host, success) {
    if (!this.hostManager.circuitBreakers.has(host)) {
      this.hostManager.circuitBreakers.set(host, {
        failures: 0,
        lastFailure: 0,
        state: 'closed'
      });
    }
    
    const breaker = this.hostManager.circuitBreakers.get(host);
    
    if (success) {
      breaker.failures = 0;
      breaker.state = 'closed';
    } else {
      breaker.failures++;
      breaker.lastFailure = Date.now();
      
      if (breaker.failures >= 3) {
        breaker.state = 'open';
        this.log(`Circuit breaker OPENED for ${host} (${breaker.failures} failures)`);
      }
    }
  }

  // New: Intelligent host selection based on performance
  _updatePreferredHost() {
    const now = Date.now();
    let bestHost = null;
    let bestScore = -1;
    
    for (const [host, info] of this.hostManager.availableHosts) {
      // Skip if circuit breaker is open
      const breaker = this.hostManager.circuitBreakers.get(host);
      if (breaker && breaker.state === 'open') {
        continue;
      }
      
      // Skip if host is too old (not seen in last 2 minutes)
      if ((now - info.lastSeen) > 120000) {
        continue;
      }
      
      // Calculate score based on response time and failure count
      let score = 1000; // Base score
      
      // Penalize by response time (lower is better)
      score -= info.responseTime;
      
      // Penalize by failure count
      score -= (info.failureCount * 100);
      
      // Bonus for primary host
      if (host === this.hostManager.primaryHost) {
        score += 50;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestHost = host;
      }
    }
    
    if (bestHost && bestHost !== this.hostManager.preferredHost) {
      this.log(`Preferred host changed: ${this.hostManager.preferredHost} → ${bestHost} (score: ${bestScore})`);
      this.hostManager.preferredHost = bestHost;
    }
  }

  // New: Clean up old/unreachable hosts
  _cleanupHostManager() {
    const now = Date.now();
    const maxAge = 300000; // 5 minutes
    
    for (const [host, info] of this.hostManager.availableHosts) {
      if ((now - info.lastSeen) > maxAge) {
        this.hostManager.availableHosts.delete(host);
        this.hostManager.circuitBreakers.delete(host);
        this.log(`Cleaned up old host: ${host}`);
      }
    }
  }

  // New: Get ordered list of hosts to try (best performance first)
  _getOrderedHostList() {
    const now = Date.now();
    const hosts = [];
    
    // Add preferred host first if available
    if (this.hostManager.preferredHost) {
      const preferredInfo = this.hostManager.availableHosts.get(this.hostManager.preferredHost);
      const breaker = this.hostManager.circuitBreakers.get(this.hostManager.preferredHost);
      
      if (preferredInfo && 
          preferredInfo.status === 'healthy' && 
          (!breaker || breaker.state !== 'open') &&
          (now - preferredInfo.lastSeen) < 120000) {
        hosts.push(this.hostManager.preferredHost);
      }
    }
    
    // Add other healthy hosts, sorted by performance
    const otherHosts = [];
    for (const [host, info] of this.hostManager.availableHosts) {
      if (host === this.hostManager.preferredHost) continue;
      
      const breaker = this.hostManager.circuitBreakers.get(host);
      if (info.status === 'healthy' && 
          (!breaker || breaker.state !== 'open') &&
          (now - info.lastSeen) < 120000) {
        otherHosts.push({ host, info });
      }
    }
    
    // Sort by response time (fastest first)
    otherHosts.sort((a, b) => a.info.responseTime - b.info.responseTime);
    hosts.push(...otherHosts.map(h => h.host));
    
    this.log(`Ordered host list: ${hosts.join(' → ')}`);
    return hosts;
  }

  // New: Update host success metrics
  _updateHostSuccess(host) {
    const now = Date.now();
    const current = this.hostManager.availableHosts.get(host) || {
      lastSeen: 0,
      responseTime: 0,
      failureCount: 0,
      status: 'unknown'
    };
    
    current.lastSeen = now;
    current.status = 'healthy';
    current.failureCount = Math.max(0, current.failureCount - 1); // Gradually reduce failure count
    
    this.hostManager.availableHosts.set(host, current);
    this._updateCircuitBreaker(host, true);
  }

  // New: Update host failure metrics
  _updateHostFailure(host, error) {
    const now = Date.now();
    const current = this.hostManager.availableHosts.get(host) || {
      lastSeen: 0,
      responseTime: 0,
      failureCount: 0,
      status: 'unknown'
    };
    
    current.failureCount++;
    current.status = 'unhealthy';
    current.lastFailure = now;
    
    this.hostManager.availableHosts.set(host, current);
    this._updateCircuitBreaker(host, false);
  }

  // New: Update connection capabilities
  async _updateConnectionCapabilities(currentHost, isFallback) {
    const isUsingFallback = isFallback || (currentHost !== this.hostManager.primaryHost);
    
    await this._updateCapability('alarm_connection_fallback', isUsingFallback);
    await this._updateCapability('status_connected_host', currentHost);
    
    if (!this.getAvailable()) {
      await this.setAvailable();
    }
  }

  // === LOGGING HELPERS ===

  _logDebug(message, ...args) {
    // Debug logging disabled in production
  }

  _logInfo(message, ...args) {
    this.log(message, ...args);
  }

  _logWarn(message, ...args) {
    this.log(message, ...args);
  }

  _logError(message, ...args) {
    this.error(message, ...args);
  }

  // === CONNECTION HEALTH MONITORING ===

  _updateConnectionHealth(success, responseTime = 0) {
    this.connectionHealth.totalCalls++;
    
    if (success) {
      this.connectionHealth.lastSuccessfulCall = Date.now();
      this.connectionHealth.consecutiveFailures = 0;
      
      // Update average response time
      const totalTime = this.connectionHealth.averageResponseTime * (this.connectionHealth.totalCalls - this.connectionHealth.totalFailures - 1);
      this.connectionHealth.averageResponseTime = (totalTime + responseTime) / (this.connectionHealth.totalCalls - this.connectionHealth.totalFailures);
    } else {
      this.connectionHealth.totalFailures++;
      this.connectionHealth.consecutiveFailures++;
    }
    
    // Connection health tracking (debug disabled in production)
  }

  _getConnectionHealthStatus() {
    const now = Date.now();
    const timeSinceLastSuccess = this.connectionHealth.lastSuccessfulCall ? 
      (now - this.connectionHealth.lastSuccessfulCall) : null;
    
    const failureRate = this.connectionHealth.totalCalls > 0 ? 
      (this.connectionHealth.totalFailures / this.connectionHealth.totalCalls) * 100 : 0;
    
    return {
      isHealthy: this.connectionHealth.consecutiveFailures < 3 && failureRate < 50,
      timeSinceLastSuccess,
      consecutiveFailures: this.connectionHealth.consecutiveFailures,
      failureRate: Math.round(failureRate * 100) / 100,
      averageResponseTime: Math.round(this.connectionHealth.averageResponseTime),
      totalCalls: this.connectionHealth.totalCalls
    };
  }

  _logConnectionHealth() {
    // Connection health logging disabled in production
  }

  // === CACHING AND DEDUPLICATION HELPERS ===

  _getCacheKey(urlPath, options = {}) {
    // Create a unique cache key based on URL path and relevant options
    const method = options.method || 'GET';
    const body = options.body || '';
    return `${method}:${urlPath}:${body}`;
  }

  _isCacheValid(cacheEntry) {
    if (!cacheEntry) return false;
    return (Date.now() - cacheEntry.timestamp) < this.cacheTimeout;
  }

  _getCachedResponse(cacheKey) {
    const cacheEntry = this.requestCache.get(cacheKey);
    if (this._isCacheValid(cacheEntry)) {
      return cacheEntry.data;
    }
    if (cacheEntry) {
      this.requestCache.delete(cacheKey); // Remove expired entry
    }
    return null;
  }

  _setCachedResponse(cacheKey, data) {
    this.requestCache.set(cacheKey, {
      data: data,
      timestamp: Date.now()
    });
  }

  _cleanupCache() {
    const now = Date.now();
    for (const [key, entry] of this.requestCache.entries()) {
      if ((now - entry.timestamp) >= this.cacheTimeout) {
        this.requestCache.delete(key);
      }
    }
  }

  // === INPUT VALIDATION HELPERS ===

  _validateApiCredentials(credentials) {
    if (!credentials) {
      throw new Error(JSON.stringify({ 
        en: 'API credentials are required.', 
        nl: 'API gegevens zijn vereist.' 
      }));
    }
    
    const { hostname, username, tokenId, tokenSecret } = credentials;
    
    // Validate hostname
    if (!hostname || typeof hostname !== 'string' || hostname.trim().length === 0) {
      throw new Error(JSON.stringify({ 
        en: 'Valid hostname is required.', 
        nl: 'Geldige hostnaam is vereist.' 
      }));
    }
    
    // Enhanced hostname validation (IP or domain)
    const hostnameRegex = /^[a-zA-Z0-9.-]+$/;
    if (!hostnameRegex.test(hostname.trim())) {
      throw new Error(JSON.stringify({ 
        en: 'Invalid hostname format.', 
        nl: 'Ongeldig hostnaam formaat.' 
      }));
    }
    
    // Additional security checks
    if (hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) {
      throw new Error(JSON.stringify({ 
        en: 'Invalid hostname format - contains invalid characters.', 
        nl: 'Ongeldig hostnaam formaat - bevat ongeldige karakters.' 
      }));
    }
    
    // Validate username
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      throw new Error(JSON.stringify({ 
        en: 'Valid username is required.', 
        nl: 'Geldige gebruikersnaam is vereist.' 
      }));
    }
    
    // Validate token ID
    if (!tokenId || typeof tokenId !== 'string' || tokenId.trim().length === 0) {
      throw new Error(JSON.stringify({ 
        en: 'Valid API token ID is required.', 
        nl: 'Geldige API token ID is vereist.' 
      }));
    }
    
    // Validate token secret
    if (!tokenSecret || typeof tokenSecret !== 'string' || tokenSecret.trim().length === 0) {
      throw new Error(JSON.stringify({ 
        en: 'Valid API token secret is required.', 
        nl: 'Geldige API token secret is vereist.' 
      }));
    }
    
    return true;
  }

  _validateVmParameters(vmId, vmType) {
    // Validate VM ID
    if (!vmId || (typeof vmId !== 'number' && typeof vmId !== 'string')) {
      throw new Error(JSON.stringify({ 
        en: 'Valid VM/Container ID is required.', 
        nl: 'Geldige VM/Container ID is vereist.' 
      }));
    }
    
    const numericId = parseInt(vmId, 10);
    if (isNaN(numericId) || numericId < 100 || numericId > 999999999) {
      throw new Error(JSON.stringify({ 
        en: 'VM/Container ID must be a number between 100 and 999999999.', 
        nl: 'VM/Container ID moet een nummer zijn tussen 100 en 999999999.' 
      }));
    }
    
    // Validate VM type
    if (!vmType || (vmType !== 'qemu' && vmType !== 'lxc')) {
      throw new Error(JSON.stringify({ 
        en: 'VM type must be either "qemu" or "lxc".', 
        nl: 'VM type moet "qemu" of "lxc" zijn.' 
      }));
    }
    
    return { vmId: numericId, vmType };
  }

  _validateNodeName(nodeName) {
    if (!nodeName || typeof nodeName !== 'string' || nodeName.trim().length === 0) {
      throw new Error(JSON.stringify({ 
        en: 'Valid node name is required.', 
        nl: 'Geldige node naam is vereist.' 
      }));
    }
    
    // Basic node name validation
    const nodeNameRegex = /^[a-zA-Z0-9.-]+$/;
    if (!nodeNameRegex.test(nodeName.trim())) {
      throw new Error(JSON.stringify({ 
        en: 'Invalid node name format.', 
        nl: 'Ongeldig node naam formaat.' 
      }));
    }
    
    return nodeName.trim();
  }

  // === API COMMUNICATION HELPERS ===

  _getApiCredentials() {
    const hostname = this.getSetting('hostname');
    const username = this.getSetting('username');
    const tokenId = this.getSetting('api_token_id');
    const tokenSecret = this.getSetting('api_token_secret');
    
    const credentials = { hostname, username, tokenId, tokenSecret, deviceName: this.getName() };
    this._validateApiCredentials(credentials);
    
    return credentials;
  }

  _getFetchOptions(credentials, hostToUse, method = 'GET', timeout = 15000) {
    if (!credentials) throw new Error('Credentials object missing for fetch options.');
    const authorizationHeader = `PVEAPIToken=${credentials.username}!${credentials.tokenId}=${credentials.tokenSecret}`;
    
    // Check if user has opted to allow self-signed certificates
    const allowSelfSigned = this.getSetting('allow_self_signed_certs') || false;
    
    // Create HTTPS agent with configurable SSL validation
    const httpsAgent = new https.Agent({ 
      rejectUnauthorized: !allowSelfSigned, // Respect user setting for SSL validation
      timeout: timeout,
      keepAlive: true,
      maxSockets: 5
    });
    
    if (allowSelfSigned) {
      this.log('⚠️ SSL certificate validation is DISABLED. This is a security risk!');
    }
    
    return {
        method: method,
        headers: { 
          'Authorization': authorizationHeader, 
          'Accept': 'application/json',
          'User-Agent': 'Homey-ProxmoxVE/1.0'
        },
        agent: httpsAgent,
        timeout: timeout
    };
  }

  // Performs a SINGLE API call attempt to a SPECIFIC host
  async _doApiCall(hostToTry, urlPath, options = {}) {
    const startTime = Date.now();
    let initialCredentials;
    try { initialCredentials = this._getApiCredentials(); }
    catch (error) { 
      this._updateConnectionHealth(false);
      throw error; 
    }

    const url = `https://${hostToTry}:8006${urlPath}`;
    const fetchOptionsConfig = this._getFetchOptions(initialCredentials, hostToTry, options.method, options.timeout);
    if (!fetchOptionsConfig) {
      this._updateConnectionHealth(false);
      throw new Error('Could not create fetch options.');
    }

    const fetchOptions = { ...fetchOptionsConfig, ...options, headers: {...fetchOptionsConfig.headers, ...options.headers} };
    fetchOptions.method = options.method || fetchOptionsConfig.method;
    if (fetchOptions.method === 'POST' && options.body) {
        fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = options.body;
     } else { delete fetchOptions.body; }

    // API call logging disabled in production
    
    try {
      const response = await fetch(url, fetchOptions); // Throws on network error
      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        let errorBody = `(Status: ${response.status} ${response.statusText})`; 
        try { errorBody = await response.text(); } catch(e) {}
        this._logError(`API Error via ${hostToTry}: ${response.status}. Body: ${errorBody.substring(0, 200)}`);
        
        // Update health tracking
        this._updateConnectionHealth(false, responseTime);
        
        // Throw specific error for API issues, include status
        const apiError = new Error(JSON.stringify({ en: `API Error: ${response.status}`, nl: `API Fout: ${response.status}` }));
        apiError.statusCode = response.status;
        throw apiError;
      }
      
      // API call successful
      this._updateConnectionHealth(true, responseTime);
      
      const text = await response.text();
      try { return JSON.parse(text); } catch(e) { return text || null; }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this._updateConnectionHealth(false, responseTime);
      throw error;
    }
  }

  // New: Enhanced API call with intelligent fallback
  async _executeApiCallWithFallback(urlPath, options = {}) {
      // Check cache first for GET requests
      if ((options.method || 'GET') === 'GET') {
        const cacheKey = this._getCacheKey(urlPath, options);
        const cachedResponse = this._getCachedResponse(cacheKey);
        if (cachedResponse) {
          return cachedResponse;
        }
      }

      // Check for pending request to avoid duplicates
      const requestKey = this._getCacheKey(urlPath, options);
      if (this.pendingRequests.has(requestKey)) {
        this.log(`Request deduplication: waiting for pending request ${requestKey}`);
        return this.pendingRequests.get(requestKey);
      }

      // Create promise for this request
      const requestPromise = this._executeApiCallWithIntelligentFallbackInternal(urlPath, options);
      this.pendingRequests.set(requestKey, requestPromise);

      try {
        const result = await requestPromise;
        
        // Cache successful GET responses
        if ((options.method || 'GET') === 'GET') {
          this._setCachedResponse(requestKey, result);
        }
        
        return result;
      } finally {
        // Always clean up pending request
        this.pendingRequests.delete(requestKey);
      }
  }

  // New: Intelligent fallback with performance-based host selection
  async _executeApiCallWithIntelligentFallbackInternal(urlPath, options = {}) {
    let credentials;
    try { 
      credentials = this._getApiCredentials(); 
    } catch (error) { 
      await this.setUnavailable({ en: error.message, nl: error.message }); 
      throw error; 
    }

    // Get ordered list of hosts to try (preferred first, then by performance)
    const hostsToTry = this._getOrderedHostList();
    
    if (hostsToTry.length === 0) {
      throw new Error(JSON.stringify({
        en: 'No available hosts found',
        nl: 'Geen beschikbare hosts gevonden'
      }));
    }

    let lastError = null;
    
    for (const host of hostsToTry) {
      this.log(`Attempting API call via host: ${host}`);
      
      try {
        const result = await this._doApiCall(host, urlPath, options);
        
        // Success! Update host status and capabilities
        this._updateHostSuccess(host);
        await this._updateConnectionCapabilities(host, false);
        
        return result;
        
      } catch (error) {
        this.error(`API call failed via ${host}: ${error.message}`);
        lastError = error;
        
        // Update host failure
        this._updateHostFailure(host, error);
        
        // Check if we should continue trying other hosts
        const isNetworkError = error.code || error.type === 'request-timeout' || !(error.message.startsWith('API Error:'));
        
        if (!isNetworkError) {
          // API error (like 401) - don't try other hosts
          this.log('API error detected, not attempting other hosts');
          await this._updateConnectionCapabilities(host, true);
          throw error;
        }
        
        // Network error - continue to next host
        this.log(`Network error on ${host}, trying next host...`);
      }
    }

    // All hosts failed
    this.log('All hosts failed, marking device unavailable');
    await this.setUnavailable({
      en: `All connection attempts failed. Last error: ${lastError?.message}`,
      nl: `Alle verbindingspogingen mislukt. Laatste fout: ${lastError?.message}`
    }).catch(this.error);
    
    throw lastError || new Error(JSON.stringify({
      en: 'All connection attempts failed',
      nl: 'Alle verbindingspogingen mislukt'
    }));
  }

  // Helper to update capability value on THIS device instance
  async _updateCapability(capabilityId, value) {
     try {
         if (!this.hasCapability(capabilityId)) {
             this.log(`Adding capability '${capabilityId}' to [${this.getName()}]`);
             await this.addCapability(capabilityId);
         }
         
         // Get current value to check if update is needed
         const currentValue = this.getCapabilityValue(capabilityId);
         
         // Always update measure capabilities to ensure frontend gets the latest values
         if (capabilityId.startsWith('measure_')) {
             await this.setCapabilityValue(capabilityId, value);
             this.log(`Capability '${capabilityId}' updated to ${value} for [${this.getName()}] (measure capability)`);
             
             // Force a device refresh by triggering a capability change event
             this.homey.emit('device:capability:changed', {
               deviceId: this.getId(),
               capabilityId: capabilityId,
               value: value
             });
             
             // Also try to trigger a device refresh
             this.homey.emit('device:refresh', {
               deviceId: this.getId()
             });
         } else if (currentValue !== value) {
             await this.setCapabilityValue(capabilityId, value);
             this.log(`Capability '${capabilityId}' updated from ${currentValue} to ${value} for [${this.getName()}]`);
         } else {
             this.log(`Capability '${capabilityId}' value unchanged (${value}), skipping update for [${this.getName()}]`);
         }
     } catch (error) { 
       this.error(`Error setting capability '${capabilityId}':`, error); 
       // Don't throw here to prevent cascading failures
     }
  }

  // Enhanced error handling with proper state management
  async _handleApiError(error, context = '') {
    const deviceName = this.getName();
    this.error(`API Error ${context} for [${deviceName}]:`, error.message);
    
    // Determine if this is a connection issue or API issue
    const isConnectionError = error.code === 'ECONNREFUSED' || 
                             error.code === 'ENOTFOUND' || 
                             error.code === 'ETIMEDOUT' ||
                             error.type === 'request-timeout';
    
    const isApiError = error.statusCode && error.statusCode >= 400;
    
    if (isConnectionError) {
      // Connection issues - set unavailable but don't clear fallback status
      await this.setUnavailable({
        en: `Connection failed: ${error.message}`,
        nl: `Verbinding mislukt: ${error.message}`
      }).catch(this.error);
    } else if (isApiError) {
      // API errors - set unavailable and clear fallback
      await this.setUnavailable({
        en: `API Error ${error.statusCode}: ${error.message}`,
        nl: `API Fout ${error.statusCode}: ${error.message}`
      }).catch(this.error);
      await this._updateCapability('alarm_connection_fallback', false);
    }
    
    return { isConnectionError, isApiError };
  }

  // Helper function to find the current node NAME for a given VM/LXC
  async _findTargetNode(vmType, vmId) {
      this.log(`Finding current node NAME for ${vmType}/${vmId} via [${this.getName()}]...`);
      try {
          // Use fallback-aware call
          const resourcesData = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
          if (Array.isArray(resourcesData?.data)) {
              const resource = resourcesData.data.find(r => r.vmid === vmId && r.type === vmType);
              if (resource?.node) return resource.node;
           }
          throw new Error(`Resource ${vmType}/${vmId} not found in cluster resources.`);
      } catch (error) {
          this.error(`Could not find node for ${vmType}/${vmId}:`, error.message);
          // Re-throw a more specific error using inline translation
          throw new Error(JSON.stringify({ en: `Could not find node for ${vmType}/${vmId}.`, nl: `Kon node niet vinden voor ${vmType}/${vmId}.` }));
      }
  }

  // === DEVICE SPECIFIC METHODS ===

  // Tests API connection ONLY using primary host (or new settings host)
  async testApiConnection(settings = null) {
    const deviceName = this.getName();
    this.log(`Testing PRIMARY API connection for [${deviceName}]...`);
    let tempCredentials;
    try {
        tempCredentials = settings
            ? { hostname: settings.hostname, username: settings.username, tokenId: settings.api_token_id, tokenSecret: settings.api_token_secret }
            : this._getApiCredentials(); // Can throw if incomplete
        if (!tempCredentials || !tempCredentials.hostname /*... etc */) {
            throw new Error(JSON.stringify({ en: 'Settings incomplete.', nl: 'Instellingen incompleet.' }));
        }
    } catch (error) {
         this.log(`[Warning] API Test Failed for [${deviceName}]: ${error.message}`);
         await this.setUnavailable({ en: error.message, nl: error.message }).catch(this.error);
         await this._updateCapability('alarm_connection_fallback', false);
         await this._updateCapability('status_connected_host', this.getSetting('hostname') || 'Unknown');
         return false;
    }

    const hostToTest = tempCredentials.hostname;

    try {
        // Use the simple _doApiCall to test ONLY this specific host
        const data = await this._doApiCall(hostToTest, '/api2/json/version', { method: 'GET', timeout: 10000 });
        this.log(`Primary API Connection OK for [${deviceName}] via ${hostToTest}. Version: ${data?.data?.version}`);
        // Don't set available or update caps here, let updateStatusAndConnection handle it
        return true;
    } catch (error) {
        this.error(`Primary API Connection Test Failed for [${deviceName}] via ${hostToTest}: ${error.message}`);
        return false; // Indicate failure
    }
  }

  // Fetches cluster status and updates related capabilities for THIS device
  async updateStatusAndConnection(newSettings = null) {
    const deviceName = this.getName();
    this.log(`Updating status and connection for [${deviceName}]...`);
    try {
      // If new settings are provided, test the primary connection with them first
      if (newSettings) {
          await this.testApiConnection(newSettings);
      }

      // Always attempt to fetch cluster status using the fallback-aware helper
      const clusterStatusData = await this._executeApiCallWithFallback('/api2/json/cluster/status');

      let nodeCount = 0;
      const onlineNodeIps = [];
      if (Array.isArray(clusterStatusData?.data)) {
        clusterStatusData.data.forEach(item => {
          if (item.type === 'node' && item.online === 1) {
            nodeCount++;
            if (item.ip) onlineNodeIps.push(item.ip);
          }
        });
      }
      await this.setStoreValue('online_node_ips', onlineNodeIps);
      this.log(`Stored online node IPs: ${onlineNodeIps.join(', ')}`);

      // Fetch resources separately for VM/LXC counts using the fallback-aware helper
      const resourcesData = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
      let activeVmCount = 0, activeLxcCount = 0;
       if (Array.isArray(resourcesData?.data)) {
          resourcesData.data.forEach(r => {
              if (r.type === 'qemu' && r.status === 'running') activeVmCount++;
              else if (r.type === 'lxc' && r.status === 'running') activeLxcCount++;
          });
       }

      await this._updateCapability('measure_node_count', nodeCount);
      await this._updateCapability('measure_vm_count', activeVmCount);
      await this._updateCapability('measure_lxc_count', activeLxcCount);
      // Fallback status, connected host, and availability are updated within _executeApiCallWithFallback

    } catch (error) {
      this.error(`Failed to update status and connection for [${deviceName}]:`, error.message);
      // setUnavailable and fallback status are handled within _executeApiCallWithFallback on final failure
    }
    return this.getAvailable(); // Return current availability status
  }


  // === FLOW CARD HANDLERS ===
  // These are now registered and handled by the Driver in driver.js
  // We add the methods here that the driver handlers will call

  // Autocomplete logic - called by driver's autocomplete handler
  async getAutocompleteResults(query) {
    const deviceName = this.getName();
    this.log(`Handling autocomplete request for [${deviceName}], Query: "${query}"`);
    const results = [];
    try {
      // Use this device's credentials via the fallback-aware helper
      const resourcesData = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
      if (Array.isArray(resourcesData?.data)) {
        resourcesData.data
          .filter(r => (r.type === 'qemu' || r.type === 'lxc') && (query === '' || r.name?.toLowerCase().includes(query.toLowerCase()) || r.vmid?.toString().includes(query)))
          .forEach(r => {
            const resourceName = r.name || `Unnamed ${r.type}`;
            results.push({
              name: `${resourceName} (${r.type} ${r.vmid})`,
              id: { vmid: r.vmid, type: r.type, name: resourceName } // Store vmid, type, and name
            });
          });
      }
    } catch (error) { this.error(`Autocomplete API error for [${deviceName}]:`, error.message); }
    this.log(`Returning ${results.length} autocomplete results for [${deviceName}].`);
    return results;
  }

  // Executes a VM/LXC power action - called by driver's run listener handler
  async executeVmAction(args, action) {
    const deviceName = this.getName();
    const selectedTarget = args.target_vm; // Comes from the Flow card argument
    const vmId = selectedTarget?.id?.vmid;
    const vmType = selectedTarget?.id?.type;

    // Validate VM parameters
    const validatedParams = this._validateVmParameters(vmId, vmType);
    const targetDesc = `${validatedParams.vmType}/${validatedParams.vmId}`;

    this.log(`Executing action '${action}' on [${deviceName}] for target: ${targetDesc}`);
    try {
      // Use 'this' context to find the node via this cluster's API (handles fallback)
      const targetNode = await this._findTargetNode(validatedParams.vmType, validatedParams.vmId);
      const apiPath = `/api2/json/nodes/${targetNode}/${validatedParams.vmType}/${validatedParams.vmId}/status/${action}`;
      const options = {
          method: 'POST',
          timeout: (action === 'shutdown' ? 30000 : 15000)
      };
      if (action === 'stop') { options.body = 'overrule-shutdown=1'; }

      this.log(`Attempting ${options.method} to ${apiPath} via [${deviceName}]`);
      // Use fallback-aware call for the action itself
      const result = await this._executeApiCallWithFallback(apiPath, options);
      this.log(`${action} command result for ${targetDesc}:`, result);
      // No return needed, error is thrown on failure

    } catch (error) {
      this.error(`Failed to ${action} ${targetDesc} via [${deviceName}]:`, error.message);
      // Re-throw user-friendly error
      throw new Error(JSON.stringify({ en: `Failed to ${action} ${targetDesc}`, nl: `${action.charAt(0).toUpperCase() + action.slice(1)}en van ${targetDesc} mislukt` }));
    }
  }

  // Checks the status for the VM/LXC Is Running Condition - called by driver's run listener handler
  async checkVmStatus(args) {
    const deviceName = this.getName();
    const selectedTarget = args.target_vm;
    const vmId = selectedTarget?.id?.vmid;
    const vmType = selectedTarget?.id?.type;

    // Validate VM parameters
    const validatedParams = this._validateVmParameters(vmId, vmType);
    const targetDesc = `${validatedParams.vmType}/${validatedParams.vmId}`;

    this.log(`Checking status for target: ${targetDesc} via [${deviceName}]`);
    try {
      // Use fallback-aware call to find node and get status
      const targetNode = await this._findTargetNode(validatedParams.vmType, validatedParams.vmId);
      const apiPath = `/api2/json/nodes/${targetNode}/${validatedParams.vmType}/${validatedParams.vmId}/status/current`;
      const statusData = await this._executeApiCallWithFallback(apiPath); // Use GET (default)
      const isRunning = statusData?.data?.status === 'running';
      this.log(`Status check result for ${targetDesc}: ${isRunning}`);
      return isRunning; // Return true or false to the driver handler

    } catch (error) {
      this.error(`Status check failed for ${targetDesc} via [${deviceName}]:`, error.message);
      // Re-throw user-friendly error
      throw new Error(JSON.stringify({ en: `Failed to check status for ${targetDesc}`, nl: `Kon status niet controleren voor ${targetDesc}` }));
    }
  }

  // Get current host status for debugging
  getHostStatus() {
    return {
      primaryHost: this.hostManager.primaryHost,
      preferredHost: this.hostManager.preferredHost,
      availableHosts: Array.from(this.hostManager.availableHosts.entries()),
      circuitBreakers: Array.from(this.hostManager.circuitBreakers.entries()),
      lastHealthCheck: this.hostManager.lastHealthCheck
    };
  }

} // End of class ProxmoxClusterDevice
