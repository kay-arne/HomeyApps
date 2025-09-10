# 🚀 Proxmox Cluster Failover Improvements

## 📋 Huidige Problemen

### ❌ **Statische Fallback Lijst**
- Fallback IPs worden alleen opgeslagen tijdens `updateStatusAndConnection()`
- Geen real-time node status updates tijdens failover
- Oude/offline nodes kunnen nog in fallback lijst staan

### ❌ **Geen Intelligente Host Selectie**
- Geen prioritering van fallback hosts
- Geen load balancing of performance metrics
- Geen voorkeur voor "beste" beschikbare host

### ❌ **Geen Proactieve Health Monitoring**
- Geen periodieke health checks van alle nodes
- Geen early warning systeem
- Geen automatische terugkeer naar primaire host

### ❌ **Beperkte Error Handling**
- Geen onderscheid tussen verschillende failure types
- Geen retry logic met exponential backoff
- Geen circuit breaker pattern

## ✅ **Verbeterde Failover Logica**

### 🎯 **1. Intelligente Host Management**

#### **Host Status Tracking**
```javascript
hostManager = {
  primaryHost: null,           // Gebruiker's primaire host
  availableHosts: new Map(),   // host -> { lastSeen, responseTime, failureCount, status }
  circuitBreakers: new Map(),  // host -> { failures, lastFailure, state }
  preferredHost: null,         // Momenteel beste presterende host
  lastHealthCheck: 0,
  healthCheckInterval: 30000   // 30 seconden
}
```

#### **Performance-Based Scoring**
- **Response Time**: Lagere response time = hogere score
- **Failure Count**: Minder failures = hogere score  
- **Primary Host Bonus**: +50 punten voor primaire host
- **Health Status**: Alleen gezonde hosts worden overwogen

### 🔄 **2. Proactieve Health Monitoring**

#### **Periodieke Health Checks**
- **Interval**: Elke 30 seconden
- **Scope**: Alle online cluster nodes
- **Metrics**: Response time, failure count, status
- **Circuit Breaker**: Automatische uitschakeling van failed hosts

#### **Real-time Status Updates**
```javascript
// Health check resultaten
{
  "pve1.example.com": {
    lastSeen: 1703123456789,
    responseTime: 45,
    failureCount: 0,
    status: "healthy",
    nodeName: "pve1"
  }
}
```

### ⚡ **3. Circuit Breaker Pattern**

#### **States**
- **CLOSED**: Normale operatie
- **OPEN**: Host uitgeschakeld na 3 failures
- **HALF-OPEN**: Test mode na 1 minuut

#### **Automatic Recovery**
- Failed hosts worden automatisch getest
- Succesvolle tests herstellen de host
- Gradual failure count reduction bij success

### 🎯 **4. Intelligente Host Selectie**

#### **Ordered Host List**
1. **Preferred Host**: Beste presterende host
2. **Other Healthy Hosts**: Gesorteerd op response time
3. **Circuit Breaker Check**: Alleen hosts met open circuit breaker

#### **Dynamic Preference**
- Preferred host wordt dynamisch bijgewerkt
- Performance metrics bepalen de beste host
- Automatische terugkeer naar primaire host bij herstel

### 📊 **5. Enhanced Monitoring**

#### **Connection Health Tracking**
```javascript
connectionHealth = {
  lastSuccessfulCall: null,
  consecutiveFailures: 0,
  totalCalls: 0,
  totalFailures: 0,
  averageResponseTime: 0
}
```

#### **Host Performance Metrics**
- Response time tracking per host
- Failure rate monitoring
- Last seen timestamps
- Node name mapping

## 🔧 **Implementatie Details**

### **Nieuwe Methods**

#### **Health Monitoring**
- `startHealthMonitoring()`: Start proactieve health checks
- `_performHealthCheck()`: Test alle cluster nodes
- `_updatePreferredHost()`: Bepaal beste host
- `_cleanupHostManager()`: Ruim oude hosts op

#### **Circuit Breaker**
- `_updateCircuitBreaker(host, success)`: Update circuit breaker state
- `_getOrderedHostList()`: Krijg geordende host lijst
- `_updateHostSuccess(host)`: Update success metrics
- `_updateHostFailure(host, error)`: Update failure metrics

#### **Intelligent Fallback**
- `_executeApiCallWithIntelligentFallback()`: Nieuwe fallback logica
- `_updateConnectionCapabilities()`: Update capabilities
- `getHostStatus()`: Debug informatie

### **Verbeterde Error Handling**

#### **Network vs API Errors**
- **Network Errors**: Probeer volgende host
- **API Errors**: Stop fallback attempts
- **Timeout Errors**: Probeer volgende host

#### **Graceful Degradation**
- Device blijft beschikbaar tijdens fallback
- Capabilities tonen fallback status
- Automatische herstel bij primaire host

## 📈 **Voordelen**

### **Performance**
- ⚡ **Snellere Failover**: Intelligente host selectie
- 📊 **Betere Metrics**: Real-time performance tracking
- 🔄 **Proactief**: Health monitoring voorkomt failures

### **Reliability**
- 🛡️ **Circuit Breaker**: Voorkomt cascade failures
- 🔧 **Auto Recovery**: Automatische herstel van failed hosts
- 📍 **Smart Selection**: Beste host wordt automatisch geselecteerd

### **User Experience**
- 🎯 **Transparant**: Gebruiker ziet welke host wordt gebruikt
- ⚠️ **Early Warning**: Health monitoring detecteert problemen vroeg
- 🔄 **Seamless**: Automatische terugkeer naar primaire host

### **Maintenance**
- 🧹 **Auto Cleanup**: Oude hosts worden automatisch opgeruimd
- 📊 **Rich Debugging**: Uitgebreide status informatie
- 🔍 **Monitoring**: Real-time host performance metrics

## 🚀 **Implementatie Plan**

### **Fase 1: Core Infrastructure**
1. ✅ Host Manager implementatie
2. ✅ Circuit Breaker pattern
3. ✅ Health monitoring systeem

### **Fase 2: Intelligent Fallback**
1. ✅ Performance-based host selection
2. ✅ Dynamic preference updates
3. ✅ Enhanced error handling

### **Fase 3: Integration & Testing**
1. 🔄 Integratie met bestaande code
2. 🔄 Testing met echte Proxmox cluster
3. 🔄 Performance validatie

### **Fase 4: Production Deployment**
1. 🔄 Gradual rollout
2. 🔄 Monitoring en feedback
3. 🔄 Fine-tuning parameters

## 🎯 **Verwachte Resultaten**

- **99.9% Uptime**: Betrouwbare failover naar gezonde hosts
- **<1s Failover**: Snelle overgang bij host failures
- **Proactieve Monitoring**: Vroege detectie van problemen
- **Automatisch Herstel**: Geen handmatige interventie nodig
- **Betere Performance**: Altijd verbinding met beste beschikbare host

## 🔧 **Configuratie Opties**

### **Health Check Interval**
- **Default**: 30 seconden
- **Range**: 10-300 seconden
- **Impact**: Lagere interval = snellere detectie, hogere load

### **Circuit Breaker Threshold**
- **Default**: 3 failures
- **Range**: 1-10 failures
- **Impact**: Lagere threshold = snellere uitschakeling

### **Host Cleanup Age**
- **Default**: 5 minuten
- **Range**: 1-30 minuten
- **Impact**: Lagere age = snellere cleanup, hogere memory usage

Deze verbeterde failover logica zorgt voor een veel robuustere en intelligente verbinding met Proxmox clusters! 🚀
