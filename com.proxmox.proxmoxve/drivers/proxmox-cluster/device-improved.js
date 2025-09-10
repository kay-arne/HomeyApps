'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');

// Enhanced Proxmox Cluster Device with Intelligent Failover
module.exports = class ProxmoxClusterDeviceImproved extends Homey.Device {
  updateIntervalId = null;
  healthCheckIntervalId = null; // New: Proactive health monitoring
  requestCache = new Map();
  pendingRequests = new Map();
  cacheTimeout = 5 * 60 * 1000;
  activeTimeouts = new Set();
  
  // Enhanced connection health tracking
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
    this.log(`Initializing Enhanced Cluster Device: ${this.getName()}`);
    try {
      this._cleanupCache();
      this._initializeHostManager();
      
      const hostname = this.getSetting('hostname');
      const username = this.getSetting('username');
      const api_token_id = this.getSetting('api_token_id');
      const api_token_secret = this.getSetting('api_token_secret');
      
      if (hostname && username && api_token_id && api_token_secret) {
        this.log('Credentials found, testing connection...');
        const connectionTest = await this.testApiConnection();
        if (connectionTest) {
          this.log('Connection test successful, proceeding with initialization');
        }
      }
      
      await this.updateStatusAndConnection();
      this.startPolling();
      this.startHealthMonitoring(); // New: Start proactive health monitoring
    } catch (error) {
      this.error(`Initialization Error for [${this.getName()}]:`, error);
      await this.setUnavailable(error.message || 'Initialization failed').catch(err => this.error('Failed to set unavailable:', err));
    }
  }

  async onDeleted() {
    this.log(`Enhanced device deleted: ${this.getName()}`);
    this.stopPolling();
    this.stopHealthMonitoring(); // New: Stop health monitoring
    this.requestCache.clear();
    this.pendingRequests.clear();
    this._clearAllTimeouts();
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
    
    this.healthCheckIntervalId = setInterval(async () => {
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
      clearInterval(this.healthCheckIntervalId);
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

  // === ENHANCED API CALL WITH INTELLIGENT FALLBACK ===

  async _executeApiCallWithIntelligentFallback(urlPath, options = {}) {
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

  // === EXISTING METHODS (simplified for brevity) ===

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

  _clearAllTimeouts() {
    for (const timeoutId of this.activeTimeouts) {
      this.homey.clearTimeout(timeoutId);
    }
    this.activeTimeouts.clear();
  }

  _getCacheKey(urlPath, options = {}) {
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
      this.requestCache.delete(cacheKey);
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

  _getApiCredentials() {
    const hostname = this.getSetting('hostname');
    const username = this.getSetting('username');
    const tokenId = this.getSetting('api_token_id');
    const tokenSecret = this.getSetting('api_token_secret');
    
    if (!hostname || !username || !tokenId || !tokenSecret) {
      throw new Error(JSON.stringify({ 
        en: 'API credentials are required.', 
        nl: 'API gegevens zijn vereist.' 
      }));
    }
    
    return { hostname, username, tokenId, tokenSecret, deviceName: this.getName() };
  }

  _getFetchOptions(credentials, hostToUse, method = 'GET', timeout = 15000) {
    const authorizationHeader = `PVEAPIToken=${credentials.username}!${credentials.tokenId}=${credentials.tokenSecret}`;
    const allowSelfSigned = this.getSetting('allow_self_signed_certs') || false;
    
    const httpsAgent = new https.Agent({ 
      rejectUnauthorized: !allowSelfSigned,
      timeout: timeout,
      keepAlive: true,
      maxSockets: 5
    });
    
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

  async _doApiCall(hostToTry, urlPath, options = {}) {
    const startTime = Date.now();
    let credentials;
    
    try { 
      credentials = this._getApiCredentials(); 
    } catch (error) { 
      this._updateConnectionHealth(false);
      throw error; 
    }

    const url = `https://${hostToTry}:8006${urlPath}`;
    const fetchOptionsConfig = this._getFetchOptions(credentials, hostToTry, options.method, options.timeout);
    const fetchOptions = { ...fetchOptionsConfig, ...options, headers: {...fetchOptionsConfig.headers, ...options.headers} };
    
    fetchOptions.method = options.method || fetchOptionsConfig.method;
    if (fetchOptions.method === 'POST' && options.body) {
      fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      fetchOptions.body = options.body;
    } else { 
      delete fetchOptions.body; 
    }

    try {
      const response = await fetch(url, fetchOptions);
      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        let errorBody = `(Status: ${response.status} ${response.statusText})`; 
        try { errorBody = await response.text(); } catch(e) {}
        
        this._updateConnectionHealth(false, responseTime);
        
        const apiError = new Error(JSON.stringify({ 
          en: `API Error: ${response.status}`, 
          nl: `API Fout: ${response.status}` 
        }));
        apiError.statusCode = response.status;
        throw apiError;
      }
      
      this._updateConnectionHealth(true, responseTime);
      
      const text = await response.text();
      try { 
        return JSON.parse(text); 
      } catch(e) { 
        return text || null; 
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this._updateConnectionHealth(false, responseTime);
      throw error;
    }
  }

  _updateConnectionHealth(success, responseTime = 0) {
    this.connectionHealth.totalCalls++;
    
    if (success) {
      this.connectionHealth.lastSuccessfulCall = Date.now();
      this.connectionHealth.consecutiveFailures = 0;
      
      const totalTime = this.connectionHealth.averageResponseTime * (this.connectionHealth.totalCalls - this.connectionHealth.totalFailures - 1);
      this.connectionHealth.averageResponseTime = (totalTime + responseTime) / (this.connectionHealth.totalCalls - this.connectionHealth.totalFailures);
    } else {
      this.connectionHealth.totalFailures++;
      this.connectionHealth.consecutiveFailures++;
    }
  }

  async _updateCapability(capabilityId, value) {
    try {
      const forceUpdate = ['alarm_connection_fallback', 'status_connected_host'].includes(capabilityId);
      if (!this.hasCapability(capabilityId)) {
        this.log(`Adding capability '${capabilityId}' to [${this.getName()}]`);
        await this.addCapability(capabilityId);
        await this.setCapabilityValue(capabilityId, value);
      } else if (forceUpdate || this.getCapabilityValue(capabilityId) !== value) {
        await this.setCapabilityValue(capabilityId, value);
      }
    } catch (error) { 
      this.error(`Error setting capability '${capabilityId}':`, error); 
    }
  }

  // === PUBLIC METHODS ===

  async testApiConnection(settings = null) {
    const deviceName = this.getName();
    this.log(`Testing API connection for [${deviceName}]...`);
    
    let tempCredentials;
    try {
      tempCredentials = settings
        ? { hostname: settings.hostname, username: settings.username, tokenId: settings.api_token_id, tokenSecret: settings.api_token_secret }
        : this._getApiCredentials();
    } catch (error) {
      this.log(`[Warning] API Test Failed for [${deviceName}]: ${error.message}`);
      return false;
    }

    const hostToTest = tempCredentials.hostname;

    try {
      const data = await this._doApiCall(hostToTest, '/api2/json/version', { method: 'GET', timeout: 10000 });
      this.log(`API Connection OK for [${deviceName}] via ${hostToTest}. Version: ${data?.data?.version}`);
      return true;
    } catch (error) {
      this.error(`API Connection Test Failed for [${deviceName}] via ${hostToTest}: ${error.message}`);
      return false;
    }
  }

  async updateStatusAndConnection(newSettings = null) {
    const deviceName = this.getName();
    this.log(`Updating status and connection for [${deviceName}]...`);
    
    try {
      if (newSettings) {
        await this.testApiConnection(newSettings);
      }

      // Use intelligent fallback for cluster status
      const clusterStatusData = await this._executeApiCallWithIntelligentFallback('/api2/json/cluster/status');

      let nodeCount = 0;
      if (Array.isArray(clusterStatusData?.data)) {
        clusterStatusData.data.forEach(item => {
          if (item.type === 'node' && item.online === 1) {
            nodeCount++;
          }
        });
      }

      // Fetch resources for VM/LXC counts
      const resourcesData = await this._executeApiCallWithIntelligentFallback('/api2/json/cluster/resources');
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

    } catch (error) {
      this.error(`Failed to update status and connection for [${deviceName}]:`, error.message);
    }
    
    return this.getAvailable();
  }

  startPolling(intervalMinutesSetting = null) {
    this.stopPolling();
    const pollIntervalMinutes = intervalMinutesSetting ?? parseFloat(this.getSetting('poll_interval_cluster') || '5');
    
    if (isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
      this.log(`Polling disabled for [${this.getName()}] (interval <= 0).`);
      return;
    }
    
    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    this.log(`Starting cluster status polling every ${pollIntervalMinutes} minutes for [${this.getName()}]`);
    
    const jitter = Math.random() * 30000;
    const initialDelay = jitter;
    
    this.updateIntervalId = setInterval(async () => {
      await this.updateStatusAndConnection().catch(error => {
        this.error(`Error during scheduled poll check for [${this.getName()}]:`, error);
      });
    }, pollIntervalMs);
    
    this._createManagedTimeout(async () => {
      await this.updateStatusAndConnection().catch(error => {
        this.error(`Error during initial poll check for [${this.getName()}]:`, error);
      });
    }, initialDelay);
  }

  stopPolling() {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
      this.log(`Stopped cluster status polling for [${this.getName()}]`);
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

} // End of class ProxmoxClusterDeviceImproved
