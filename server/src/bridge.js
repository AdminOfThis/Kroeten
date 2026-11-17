// Connection to the bridge node (firmware: "gateway") over USB serial.
//
// The link object is either a real serial port (SerialLink) or the simulator.
// Both emit 'open', 'close', 'message' (parsed frame) and 'debug' (text line)
// and offer write(obj).
import { EventEmitter } from 'node:events';

import { SerialPort, ReadlineParser } from 'serialport';

import { frameLine, parseLine } from './protocol.js';

export const KNOWN_USB_VENDORS = ['10c4', '1a86', '0403', '303a']; // CP210x, CH340, FTDI, Espressif
const FRAME_SPACING_MS = 40; // pace radio frames so the gateway TX queue never overflows
const PROBE_MS = 7000; // time a candidate port has to prove it is the bridge node
const REJECT_MS = 30000; // skip a port that did not answer for this long

// Auto-detection: candidate ports (known USB-serial chips) are opened one after
// another; a port is accepted only once a valid framed message arrives, so a
// game node plugged in for flashing is never mistaken for the bridge node.
export class SerialLink extends EventEmitter {
  constructor({ path, baudRate = 115200, log = console }) {
    super();
    this.fixedPath = path;
    this.baudRate = baudRate;
    this.log = log;
    this.port = null;
    this.path = null;
    this.verified = false;
    this.retryTimer = null;
    this.probeTimer = null;
    this.reserved = new Set(); // ports in use by the flasher
    this.rejected = new Map(); // path -> retry-after timestamp
  }

  async start() {
    await this.tryOpen();
  }

  async findPorts() {
    if (this.fixedPath) return this.reserved.has(this.fixedPath) ? [] : [this.fixedPath];
    const now = Date.now();
    const ports = await SerialPort.list();
    return ports
      .filter((p) => KNOWN_USB_VENDORS.includes((p.vendorId || '').toLowerCase()))
      .map((p) => p.path)
      .filter((p) => !this.reserved.has(p) && !((this.rejected.get(p) || 0) > now));
  }

  scheduleRetry(ms = 3000) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.tryOpen(), ms);
  }

  async tryOpen() {
    if (this.port) return;
    let paths = [];
    try {
      paths = await this.findPorts();
    } catch (err) {
      this.log.warn?.(`serial: listing ports failed: ${err.message}`);
    }
    if (!paths.length) {
      this.scheduleRetry();
      return;
    }
    const path = paths[0];
    const port = new SerialPort({ path, baudRate: this.baudRate, autoOpen: false });
    port.open((err) => {
      if (err) {
        this.log.warn?.(`serial: cannot open ${path}: ${err.message}`);
        if (!this.fixedPath) this.rejected.set(path, Date.now() + REJECT_MS);
        this.scheduleRetry(500);
        return;
      }
      this.port = port;
      this.path = path;
      this.verified = Boolean(this.fixedPath);
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', (line) => this.onLine(line));
      port.on('close', () => {
        clearTimeout(this.probeTimer);
        const wasVerified = this.verified;
        this.port = null;
        this.verified = false;
        if (wasVerified) {
          this.log.warn?.(`serial: ${path} closed`);
          this.emit('close');
        }
        this.scheduleRetry(wasVerified ? 3000 : 300);
      });
      port.on('error', (e) => this.log.warn?.(`serial: ${e.message}`));

      if (this.verified) {
        this.log.info?.(`serial: connected to ${path}`);
        this.emit('open', path);
        return;
      }
      // Probe: opening resets most ESP32 boards; ask again once it has booted.
      this.writeRaw({ t: 'hello' });
      setTimeout(() => this.port === port && !this.verified && this.writeRaw({ t: 'hello' }), 2500);
      this.probeTimer = setTimeout(() => {
        if (this.port === port && !this.verified) {
          this.log.info?.(`serial: no bridge node on ${path}, trying other ports`);
          this.rejected.set(path, Date.now() + REJECT_MS);
          port.close();
        }
      }, PROBE_MS);
    });
  }

  onLine(line) {
    let msg = null;
    try {
      msg = parseLine(line);
    } catch (err) {
      this.emit('debug', `corrupt frame (${err.message}): ${line.slice(0, 80)}`);
      return;
    }
    if (!msg) {
      if (line.trim()) this.emit('debug', line.trim());
      return;
    }
    if (!this.verified) {
      this.verified = true;
      clearTimeout(this.probeTimer);
      this.log.info?.(`serial: bridge node found on ${this.path}`);
      this.emit('open', this.path);
    }
    this.emit('message', msg);
  }

  // Used by the flasher: stop using `path` (closing it if necessary).
  reserve(path) {
    this.reserved.add(path);
    if (this.path === path && this.port) this.port.close();
  }

  release(path) {
    this.reserved.delete(path);
    this.rejected.delete(path);
    this.scheduleRetry(1000);
  }

  get isOpen() {
    return Boolean(this.port?.isOpen);
  }

  writeRaw(obj) {
    if (!this.isOpen) return false;
    this.port.write(frameLine(obj));
    return true;
  }

  write(obj) {
    if (!this.verified) return false;
    return this.writeRaw(obj);
  }
}

export class Bridge extends EventEmitter {
  constructor(link, log = console) {
    super();
    this.link = link;
    this.log = log;
    this.connected = false;
    this.gateway = null; // last status report
    this.lastGatewayMs = 0;
    this.frameQueue = [];
    this.frameTimer = null;
    this.debugLines = [];
    this.handlers = { reliable: null, heartbeat: null, hello: null };

    link.on('open', (path) => {
      this.connected = true;
      this.path = path;
      this.emit('status');
      this.emit('connected', path);
      this.link.write({ t: 'hello' });
    });
    link.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.gateway = null;
      this.frameQueue = [];
      this.emit('status');
      if (wasConnected) this.emit('disconnected', this.path);
    });
    link.on('debug', (line) => {
      this.debugLines.push({ at: Date.now(), line });
      if (this.debugLines.length > 200) this.debugLines.shift();
      this.emit('debug', line);
    });
    link.on('message', (msg) => this.onMessage(msg));
  }

  status() {
    return {
      simulated: Boolean(this.simulated),
      connected: this.connected,
      path: this.path ?? null,
      gateway: this.gateway,
      lastSeen: this.lastGatewayMs || null,
      pendingFrames: this.frameQueue.length,
    };
  }

  onMessage(msg) {
    switch (msg.t) {
      case 'hello':
        this.gateway = { ...(this.gateway || {}), id: msg.id, fw: msg.fw, ql: msg.ql };
        this.lastGatewayMs = Date.now();
        this.emit('status');
        this.handlers.hello?.();
        break;
      case 'gw':
        this.gateway = msg;
        this.lastGatewayMs = Date.now();
        this.emit('status');
        break;
      case 'msg': {
        // Reliable message: ACK only after it has been committed.
        try {
          this.handlers.reliable?.(msg.node >>> 0, Buffer.from(msg.p, 'hex'));
          this.link.write({ t: 'ack', q: msg.q });
        } catch (err) {
          if (err?.code?.startsWith?.('ERR_SQLITE') || err?.errcode) {
            // DB problem: do not ACK, the gateway will retry.
            this.log.error?.(`db error, message ${msg.q} not acked: ${err.message}`);
          } else {
            // Undecodable message: ACK it anyway so it cannot block the queue.
            this.log.error?.(`dropping malformed message ${msg.q}: ${err.message}`);
            this.link.write({ t: 'ack', q: msg.q });
          }
        }
        break;
      }
      case 'air':
        // Radio traffic report of the bridge station (dashboard map).
        this.emit('air', msg);
        break;
      case 'rx':
        this.handlers.rx?.(msg.node >>> 0, msg.pt, msg.hops, Buffer.from(msg.p || '', 'hex'));
        break;
      default:
        break;
    }
  }

  send(obj) {
    return this.link.write(obj);
  }

  // Queue a radio frame for the gateway. dst: node id or 'all'.
  sendFrame(dst, pt, payload) {
    if (!this.connected) return;
    this.frameQueue.push({ t: 'send', dst, pt, p: payload.toString('hex') });
    this.pumpFrames();
  }

  pumpFrames() {
    if (this.frameTimer) return;
    const next = () => {
      const f = this.frameQueue.shift();
      if (!f) {
        this.frameTimer = null;
        return;
      }
      this.link.write(f);
      this.frameTimer = setTimeout(next, FRAME_SPACING_MS);
    };
    next();
  }
}
