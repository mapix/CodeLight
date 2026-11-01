import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isPrivateHost, peerMaterial } from '@slopus/happy-wire/codelight';
import { BridgeError } from '../errors.mjs';
import { ConnectionChannelsManager } from '../network/connection-channels.mjs';
import { DeviceProofVerifier } from '../network/device-proof.mjs';
import { EntryProbes } from '../network/public-access.mjs';
import { createPairingGateway } from './pairing-gateway.mjs';
import { CodeLightRecentService } from './recent-data.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {'local'|'cloudflare'|'relay'} Kind */
/** @typedef {ConstructorParameters<typeof ConnectionChannelsManager>[0]} ManagerOptions */
/** @typedef {Record<string,{address:string,family:string|number,internal:boolean}[]|undefined>} Interfaces */
/** @typedef {{state:string,cloudflared:string,upstream:string,account:Value,devices:import('./device-registry.mjs').DeviceRegistry,invitations:import('./pairing-gateway.mjs').PairingInvitations,daemon:import('./mac-daemon.mjs').CodeLightMacDaemon,metrics?:Pick<import('./gateway-metrics.mjs').GatewayMetrics,'request'|'trackSocket'>,notificationsAvailable?:boolean,interfaces?:()=>Interfaces,gatewayFactory?:typeof createPairingGateway,managerFactory?:(options:ManagerOptions)=>ConnectionChannelsManager}} Options */

/** Only real private IPv4 interfaces become LAN listeners; the public entries have separate gateways.
 * @param {Interfaces} [interfaces] */
export function privateLANAddresses(interfaces = networkInterfaces()) {
  const addresses = new Set();
  for (const rows of Object.values(interfaces)) for (const row of rows ?? []) {
    if (row.internal || !['IPv4', '4'].includes(String(row.family)) || !isPrivateHost(row.address)
      || row.address === '127.0.0.1' || row.address === 'localhost') continue;
    addresses.add(row.address);
  }
  return [...addresses].sort().slice(0, 3);
}

/** Composes network-only entries around one existing Mac account, daemon and proof owner. */
export class MacConnectionService extends EventEmitter {
  /** @param {Options} options */
  constructor(options) {
    super(); this.options = options; this.closed = false; this.cancel = new AbortController();
    this.gateways = /** @type {Set<ReturnType<typeof createPairingGateway>>} */ (new Set());
    this.publicGateways = /** @type {Map<Kind,{gateway:ReturnType<typeof createPairingGateway>,origin:string}>} */ (new Map());
    this.gatewayClosures = /** @type {WeakMap<ReturnType<typeof createPairingGateway>,Promise<void>>} */ (new WeakMap());
    this.probes = new Map(/** @type {Kind[]} */ (['local', 'cloudflare', 'relay']).map(kind => [kind, new EntryProbes()]));
    this.started = /** @type {Promise<Value>|null} */ (null); this.lastPairing = /** @type {string|null} */ (null);
    const managerOptions = /** @type {ManagerOptions} */ ({ state: options.state, cloudflared: options.cloudflared,
      upstreamFor: kind => { const gateway = this.publicGateways.get(kind); if (!gateway) throw Error('connection-gateway-unavailable'); return gateway.origin; },
      probesFor: kind => /** @type {EntryProbes} */ (this.probes.get(kind)), startLocal: signal => this.startLocal(signal) });
    this.manager = options.managerFactory?.(managerOptions) ?? new ConnectionChannelsManager(managerOptions);
    this.proof = new DeviceProofVerifier({ key: options.invitations.pair.secretKey, devices: options.devices,
      origins: () => this.candidates().map(row => row.url) });
    const publicKey = Buffer.from(options.invitations.pair.publicKey).toString('base64url');
    this.peerIdentity = createHash('sha256').update(peerMaterial(publicKey, options.account.secret)).digest('hex');
    this.recent = new CodeLightRecentService({ sources: () => this.sources(), resolveSource: id => this.resolveSource(id),
      available: () => this.available() });
    this.manager.on('configuration', value => { if (!this.closed) this.emit('configuration', value); });
    this.manager.on('channels', value => { if (!this.closed) this.emit('channels', value); });
  }

  start() { if (!this.started) this.started = this.initialize(); return this.started; }

  async initialize() {
    await Promise.allSettled(/** @type {Kind[]} */ (['cloudflare', 'relay']).map(async kind => {
      try {
        const gateway = await this.gateway(kind, '127.0.0.1', () => this.kindOrigin(kind), this.cancel.signal);
        const address = gateway.address(); if (!address || typeof address === 'string') throw Error('connection-gateway-unavailable');
        if (this.closed) throw Error('connection-service-cancelled');
        this.publicGateways.set(kind, { gateway, origin: 'http://127.0.0.1:' + address.port });
      } catch { if (!this.closed) this.emit('diagnostic', { code: 'connection-gateway-unavailable', kind }); }
    }));
    if (this.closed) throw Error('connection-service-cancelled');
    return this.manager.load();
  }

  candidates() { return this.closed ? [] : this.manager.candidates(); }
  primaryOrigin() { return this.manager.preferredOrigin() || this.candidates()[0]?.url || ''; }
  peerId() { return this.peerIdentity; }
  /** @param {Kind} kind */
  kindOrigin(kind) { return this.candidates().find(row => row.kind === kind)?.url ?? null; }

  /** Only changes, explicit refresh and expiry renewal rotate the invitation, not every authenticated request.
   * @param {boolean} [force] */
  pairing(force = false) {
    const channels = this.candidates(), origin = this.primaryOrigin(), fingerprint = JSON.stringify([origin, channels]);
    if (!force && fingerprint === this.lastPairing) return null;
    if (!channels.length || !origin || this.closed) { this.lastPairing = fingerprint; return { origin: '', pairingUrl: '', channels: [] }; }
    const invitation = this.options.invitations.issue(origin, channels); this.lastPairing = fingerprint;
    return { origin, pairingUrl: invitation.url, expires: invitation.expires, channels };
  }

  available() { const daemon = this.options.daemon; return !this.closed && !daemon.closed && daemon.ownsLease && daemon.inventoryAvailable; }
  sources() { return [...this.options.daemon.sources].map(([key, entry]) => ({ ...entry, actor: this.options.daemon.actors.get(key) })); }

  /** @param {string} id */
  source(id) {
    const match = [...this.options.daemon.sources].find(([, entry]) => entry.binding.happySessionId === id);
    if (!match || match[1].source.app !== 'codex' || match[1].binding.metadata?.nativeSession?.catalogueAvailable === false) throw new BridgeError('source-unavailable', 'The selected native source is unavailable.', 503);
    return { key: match[0], entry: match[1] };
  }

  /** Preparation reuses the existing source actor and never calls desktop navigation.
   * @param {string} id @returns {Promise<{source:Value,binding:Value,actor:Value}>} */
  async resolveSource(id) {
    const { key } = this.source(id), daemon = this.options.daemon;
    return /** @type {Promise<{source:Value,binding:Value,actor:Value}>} */ (daemon.useSource(key, async () => {
      const actor = await daemon.prepareSource(key); await daemon.startSource(key, actor);
      const { entry } = this.source(id); return { ...entry, actor };
    }));
  }

  /** Peer routes contain read-only selection/history data, not a second command admission path.
   * @param {string} path @param {string} method @param {Value} body @param {string} device @returns {Promise<Value>} */
  async peerApi(path, method, body, device) {
    if (this.closed || !this.options.devices.publicKey(device)) throw new BridgeError('unknown-device', 'The approved device is unavailable.', 401);
    const url = new URL(path, 'http://127.0.0.1');
    if (!path.startsWith('/api/peer/') || url.origin !== 'http://127.0.0.1') throw new BridgeError('invalid-peer-route', 'The peer route is invalid.', 400);
    if (url.pathname === '/api/peer/channels' && method === 'GET') return { version: 2, channels: this.candidates() };
    const params = Object.fromEntries(url.searchParams);
    if (Object.keys(params).some(key => !['limit', 'cursor'].includes(key))) throw new BridgeError('invalid-peer-request', 'The peer query is invalid.', 400);
    if (url.pathname === '/api/peer/catalog' && method === 'GET') return this.recent.catalog(params);
    const selected = url.pathname.match(/^\/api\/peer\/sessions\/([^/]+)\/(recent|history)$/u);
    if (!selected || selected[2] === 'recent' && method !== 'POST' || selected[2] === 'history' && method !== 'GET') throw new BridgeError('unsupported-peer-route', 'The peer route is unavailable.', 404);
    const id = decodeURIComponent(selected[1]);
    if (!id || id.length > 200 || id.includes('/')) throw new BridgeError('invalid-session', 'A selected native session is required.');
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => key !== 'limit')) throw new BridgeError('invalid-peer-request', 'The recent request is invalid.');
    const { key } = this.source(id);
    // resolveSource 的准备阶段结束后仍需保留 pin；否则另一手机的容量回收会在实际 readRecent 前关闭 observer。
    return this.options.daemon.useSource(key, () => selected[2] === 'recent' ? this.recent.recent(id, body) : this.recent.history(id, params));
  }

  /** @param {Kind} kind @param {string} host @param {()=>string|null} origin @param {AbortSignal} signal */
  async gateway(kind, host, origin, signal) {
    if (this.closed || signal.aborted) throw Error('connection-service-cancelled');
    const options = { upstream: this.options.upstream, invitations: this.options.invitations, devices: this.options.devices,
      metrics: this.options.metrics, notificationsAvailable: this.options.notificationsAvailable,
      entryProbe: (/** @type {unknown} */ challenge) => this.probes.get(kind)?.response(challenge) ?? null,
      proof: this.proof, requireProof: kind === 'local', expectedOrigin: () => origin() ?? 'https://unavailable.invalid',
      onVerified: () => { const value = origin(); if (value) this.manager.confirm(kind, value); },
      peerApi: (/** @type {string} */ path, /** @type {string} */ method, /** @type {Value} */ body, /** @type {string} */ device) => this.peerApi(path, method, body, device),
      peerId: () => this.peerId() };
    const gateway = (this.options.gatewayFactory ?? createPairingGateway)(options); this.gateways.add(gateway);
    gateway.on('error', () => { if (!this.closed) this.emit('diagnostic', { code: 'connection-gateway-unavailable', kind }); });
    try {
      const listening = once(gateway, 'listening', { signal }); gateway.listen(0, host); await listening;
      if (this.closed || signal.aborted) throw Error('connection-service-cancelled');
      return gateway;
    } catch (error) { await this.closeGateway(gateway); throw error; }
  }

  /** @param {AbortSignal} signal */
  async startLocal(signal) {
    const hosts = privateLANAddresses(this.options.interfaces?.()), gateways = /** @type {ReturnType<typeof createPairingGateway>[]} */ ([]);
    const channels = /** @type {{id:string,kind:'local',url:string,label:string}[]} */ ([]);
    const cancel = AbortSignal.any([signal, this.cancel.signal]);
    await Promise.allSettled(hosts.map(async host => {
      let origin = '';
      try {
        const gateway = await this.gateway('local', host, () => origin, cancel), address = gateway.address();
        if (!address || typeof address === 'string') { await this.closeGateway(gateway); throw Error('local-network-unavailable'); }
        gateways.push(gateway); origin = `http://${host}:${address.port}`;
        channels.push({ id: 'lan_' + createHash('sha256').update(host).digest('hex').slice(0, 16), kind: 'local', url: origin, label: 'Local network' });
      } catch { if (!cancel.aborted) this.emit('diagnostic', { code: 'local-network-unavailable', kind: 'local' }); }
    }));
    if (cancel.aborted || this.closed || !channels.length) {
      await Promise.allSettled(gateways.map(gateway => this.closeGateway(gateway))); throw Error('local-network-unavailable');
    }
    channels.sort((a, b) => a.id.localeCompare(b.id));
    return { channels, close: async () => { await Promise.allSettled(gateways.map(gateway => this.closeGateway(gateway))); } };
  }

  /** @param {ReturnType<typeof createPairingGateway>} gateway */
  closeGateway(gateway) {
    const previous = this.gatewayClosures.get(gateway); if (previous) return previous;
    gateway.closeAllConnections();
    const closing = new Promise(resolve => gateway.close(() => { this.gateways.delete(gateway); resolve(undefined); }));
    this.gatewayClosures.set(gateway, closing); return closing;
  }

  async close() {
    if (this.closed) return; this.closed = true; this.cancel.abort();
    await this.manager.close(); await Promise.allSettled([...this.gateways].map(gateway => this.closeGateway(gateway)));
    this.publicGateways.clear(); this.proof.seen.clear();
  }
}
