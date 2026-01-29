'use strict';

class HostManager {

  constructor(logger) {
    this.log = logger || console.log;
    this.hosts = new Map(); // host => { lastSeen, responseTime, failureCount, status: 'healthy'|'unhealthy'|'unknown' }
    this.circuitBreakers = new Map(); // host => { failures, lastFailure, state: 'closed'|'open'|'half-open' }
    this.primaryHost = null;
    this.preferredHost = null;

    // Configuration
    this.timeouts = {
      breakerOpen: 60000, // 1 minute before trying again (half-open)
      maxHostAge: 300000, // 5 minutes before forgetting a host completely
      recentHost: 120000, // 2 minutes to consider a host "recently seen" for preference
    };
  }

  initialize(primaryHost, initialHosts = []) {
    this.primaryHost = primaryHost;
    this.preferredHost = primaryHost;

    // Initialize primary
    this.updateHostStatus(primaryHost, true, 0);

    // Initialize others if known
    for (const host of initialHosts) {
      if (host && host !== primaryHost) {
        // Initialize as healthy/recent so circuit breaker is closed and they are candidates
        this.updateHostStatus(host, true, 0);
      }
    }
    this.log(`HostManager initialized. Primary: ${primaryHost}, Backups: ${initialHosts.length}`);
  }

  setPrimaryHost(host) {
    this.primaryHost = host;
    // Reset circuit breaker for new primary to ensure we try it
    this._resetCircuitBreaker(host);
    this.preferredHost = host;
    this.log(`Primary host updated to: ${host}`);
  }

  updateHostStatus(host, success, responseTime = 0) {
    const now = Date.now();
    const current = this.hosts.get(host) || {
      lastSeen: 0,
      responseTime: 0,
      failureCount: 0,
      status: 'unknown',
    };

    if (success) {
      current.lastSeen = now;
      current.status = 'healthy';
      current.responseTime = responseTime;
      current.failureCount = 0; // Immediate forgiveness: if it works, we trust it again instantly
      this._resetCircuitBreaker(host);
    } else {
      current.failureCount++;
      current.status = 'unhealthy';
      current.lastFailure = now;
      this._recordFailure(host);
    }

    this.hosts.set(host, current);

    // Recalculate preference if needed
    if (success) {
      this._updatePreferredHost();
    }
  }

  _recordFailure(host) {
    if (!this.circuitBreakers.has(host)) {
      this.circuitBreakers.set(host, { failures: 0, lastFailure: 0, state: 'closed' });
    }

    const breaker = this.circuitBreakers.get(host);
    breaker.failures++;
    breaker.lastFailure = Date.now();

    if (breaker.failures >= 3 && breaker.state !== 'open') {
      breaker.state = 'open';
      this.log(`Circuit breaker OPENED for ${host} (${breaker.failures} failures)`);
    }
  }

  _resetCircuitBreaker(host) {
    if (this.circuitBreakers.has(host)) {
      const breaker = this.circuitBreakers.get(host);
      breaker.failures = 0;
      breaker.state = 'closed';
    }
  }

  _getCircuitBreakerState(host) {
    const breaker = this.circuitBreakers.get(host);
    if (!breaker) return 'closed';

    if (breaker.state === 'open') {
      // Check if we can move to half-open
      if (Date.now() - breaker.lastFailure > this.timeouts.breakerOpen) {
        breaker.state = 'half-open';
        // this.log(`Circuit breaker HALF-OPEN for ${host}`); // Verbose
        return 'half-open';
      }
    }
    return breaker.state;
  }

  _updatePreferredHost() {
    const now = Date.now();
    let bestHost = null;
    let bestScore = -Infinity;

    for (const [host, info] of this.hosts) {
      // Skip open breakers
      if (this._getCircuitBreakerState(host) === 'open') continue;

      // Skip old hosts
      if (now - info.lastSeen > this.timeouts.maxHostAge) continue;

      // Score: Base (1000) - ResponseTime - (Failures * 100) + (PrimaryBonus * 50)
      let score = 1000 - info.responseTime - (info.failureCount * 100);
      if (host === this.primaryHost) score += 50;

      if (score > bestScore) {
        bestScore = score;
        bestHost = host;
      }
    }

    if (bestHost && bestHost !== this.preferredHost) {
      this.log(`Preferred host switched: ${this.preferredHost} -> ${bestHost} (Score: ${bestScore})`);
      this.preferredHost = bestHost;
    }
  }

  getOrderedHostList() {
    const now = Date.now();
    const candidates = [];

    // 1. Preferred Host (if healthy/half-open and recent)
    if (this.preferredHost) {
      const info = this.hosts.get(this.preferredHost);
      const state = this._getCircuitBreakerState(this.preferredHost);
      if (info && state !== 'open' && (now - info.lastSeen < this.timeouts.recentHost)) {
        candidates.push({ host: this.preferredHost, score: 999999 });
      }
    }

    // 2. Other Hosts
    for (const [host, info] of this.hosts) {
      if (host === this.preferredHost) continue;
      const state = this._getCircuitBreakerState(host);
      if (state === 'open') continue;
      if (now - info.lastSeen > this.timeouts.maxHostAge) continue;

      // Simple sort score for backup candidates: Response Time mainly
      candidates.push({ host, score: -info.responseTime });
    }

    // Sort descending by score
    // Primary/Preferred will be at top due to high manual score, others by low response time (simulated by negative)
    candidates.sort((a, b) => b.score - a.score);

    // If list is empty (everything broken?), ensure Primary is returned at least to try
    if (candidates.length === 0 && this.primaryHost) {
      return [this.primaryHost];
    }

    return candidates.map((c) => c.host);
  }

  cleanup() {
    const now = Date.now();
    for (const [host, info] of this.hosts) {
      if (now - info.lastSeen > this.timeouts.maxHostAge) {
        this.hosts.delete(host);
        this.circuitBreakers.delete(host);
        // this.log(`Cleaned up old host: ${host}`);
      }
    }
  }

  getDebugStatus() {
    return {
      primary: this.primaryHost,
      preferred: this.preferredHost,
      hosts: Object.fromEntries(this.hosts),
      breakers: Object.fromEntries(this.circuitBreakers),
    };
  }

}

module.exports = HostManager;
