// Builds and uploads firmware to an ESP32 connected via USB, using the
// PlatformIO CLI ("pio run -e <env> -t upload --upload-port <port>").
//
// Only one job runs at a time. Output lines are emitted as 'log' events and
// kept for the dashboard. If the selected port is the bridge node's, the
// serial link releases it for the duration of the upload.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SerialPort } from 'serialport';

import { KNOWN_USB_VENDORS } from './bridge.js';
import { firmwareList } from './nodeTypes.js';

const MAX_LOG_LINES = 600;

export class Flasher extends EventEmitter {
  constructor({ firmwareDir, link, log = console }) {
    super();
    this.firmwareDir = firmwareDir;
    this.link = link; // SerialLink (real mode) - may lack reserve/release (simulator)
    this.log = log;
    this.job = null;
    this.pio = null;
  }

  // Locates the PlatformIO CLI. Tried in order:
  //   FK_PIO env var, pio/platformio on the PATH, the VS Code PlatformIO install,
  //   the Scripts folders of the installed Python (pip installs pio.exe there,
  //   often not on the PATH - e.g. Microsoft Store Python), "python -m platformio".
  // Each candidate is [command, ...prefixArgs]. Cached (false = not found).
  async findPio() {
    if (this.pio !== null) return this.pio;
    const home = os.homedir();
    const exe = process.platform === 'win32' ? '.exe' : '';
    const candidates = [
      process.env.FK_PIO ? [process.env.FK_PIO] : null,
      ['pio'],
      ['platformio'],
      [path.join(home, '.platformio', 'penv', 'Scripts', 'pio.exe')],
      [path.join(home, '.platformio', 'penv', 'bin', 'pio')],
    ].filter(Boolean);
    for (const dir of await pythonScriptDirs()) candidates.push([path.join(dir, `pio${exe}`)]);
    for (const py of PYTHONS) candidates.push([py, '-m', 'platformio']);

    for (const [cmd, ...prefix] of candidates) {
      if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) continue;
      const version = await probeVersion(cmd, prefix);
      if (version) {
        this.pio = { cmd, prefix, display: [cmd, ...prefix].join(' '), version };
        this.log.info?.(`PlatformIO found: ${this.pio.display} (${version})`);
        return this.pio;
      }
    }
    this.pio = false;
    return this.pio;
  }

  async info({ refresh = false } = {}) {
    if (refresh) this.pio = null;
    const pio = await this.findPio();
    return {
      pio: pio ? { found: true, cmd: pio.display, version: pio.version } : { found: false },
      firmwareDir: this.firmwareDir,
      firmwareDirFound: fs.existsSync(path.join(this.firmwareDir, 'platformio.ini')),
      firmwares: firmwareList(),
      job: this.jobStatus(),
    };
  }

  async ports(bridgePath) {
    const list = await SerialPort.list();
    return list.map((p) => ({
      path: p.path,
      description: [p.manufacturer, p.friendlyName].filter(Boolean).join(' · ') || null,
      likelyEsp: KNOWN_USB_VENDORS.includes((p.vendorId || '').toLowerCase()),
      isBridge: p.path === bridgePath,
    }));
  }

  jobStatus(withLog = false) {
    if (!this.job) return null;
    const { id, env, port, label, state, startedAt, endedAt, exitCode } = this.job;
    return { id, env, port, label, state, startedAt, endedAt, exitCode, ...(withLog ? { log: this.job.log } : {}) };
  }

  async flash({ env, port }) {
    if (this.job?.state === 'running') throw httpError(409, 'Es läuft bereits ein Flash-Vorgang');
    const fw = firmwareList().find((f) => f.env === env);
    if (!fw) throw httpError(400, 'Unbekannte Firmware');
    if (!port || typeof port !== 'string') throw httpError(400, 'Bitte einen USB-Port wählen');
    const pio = await this.findPio();
    if (this.job?.state === 'running') throw httpError(409, 'Es läuft bereits ein Flash-Vorgang');
    if (!pio) throw httpError(400, 'PlatformIO wurde nicht gefunden');
    if (!fs.existsSync(path.join(this.firmwareDir, 'platformio.ini'))) {
      throw httpError(500, `Firmware-Projekt nicht gefunden: ${this.firmwareDir}`);
    }

    const job = {
      id: Date.now(),
      env,
      port,
      label: fw.label,
      state: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      log: [],
    };
    this.job = job;
    this.link?.reserve?.(port);
    this.addLine(job, `> ${pio.display} run -e ${env} -t upload --upload-port ${port}`);
    this.emit('status', this.jobStatus());

    const child = spawn(pio.cmd, [...pio.prefix, 'run', '-e', env, '-t', 'upload', '--upload-port', port], {
      cwd: this.firmwareDir,
      windowsHide: true,
      env: { ...process.env, PLATFORMIO_NO_ANSI: 'true', PYTHONUNBUFFERED: '1' },
    });
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n|\r/)) {
        if (line.trim()) this.addLine(job, line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    job.child = child;
    const finish = (code, errMsg) => {
      if (job.state !== 'running') return;
      if (errMsg) this.addLine(job, errMsg);
      job.exitCode = code;
      job.state = job.cancelRequested ? 'cancelled' : code === 0 ? 'success' : 'failed';
      job.endedAt = Date.now();
      job.child = null;
      this.addLine(
        job,
        job.state === 'cancelled'
          ? '✖ Flashen abgebrochen – das Gerät erneut flashen, bevor es verwendet wird'
          : code === 0
            ? '✔ Flashen erfolgreich'
            : `✖ Flashen fehlgeschlagen (Code ${code})`,
      );
      // Give the board a moment to boot before the bridge link may probe it.
      setTimeout(() => this.link?.release?.(port), 2000);
      this.log.info?.(`flash ${env} on ${port}: ${job.state}`);
      this.emit('status', this.jobStatus());
    };
    child.on('error', (err) => finish(-1, `Fehler beim Starten: ${err.message}`));
    child.on('close', (code) => finish(code ?? -1));
    return this.jobStatus();
  }

  // Stops a running flash job. The whole process tree is killed (PlatformIO
  // starts the build and the upload tool as child processes).
  cancel() {
    const job = this.job;
    if (!job || job.state !== 'running' || !job.child) throw httpError(409, 'Es läuft kein Flash-Vorgang');
    job.cancelRequested = true;
    this.addLine(job, '> Abbruch angefordert…');
    const pid = job.child.pid;
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      job.child.kill('SIGTERM');
    }
    return this.jobStatus();
  }

  // Log entries carry their time: { at: unix ms, line }.
  addLine(job, line) {
    const entry = { at: Date.now(), line };
    job.log.push(entry);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
    this.emit('log', entry);
  }
}

const PYTHONS = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];

// Script folders of the installed Python interpreters (system and user scheme).
async function pythonScriptDirs() {
  const code =
    'import sysconfig,os\n' +
    'dirs={sysconfig.get_path("scripts")}\n' +
    'for s in ("nt_user","posix_user","osx_framework_user"):\n' +
    '  try: dirs.add(sysconfig.get_path("scripts", s))\n' +
    '  except Exception: pass\n' +
    'print("\\n".join(d for d in dirs if d and os.path.isdir(d)))';
  const dirs = new Set();
  for (const py of PYTHONS) {
    const out = await runCapture(py, ['-c', code]);
    if (out) out.split(/\r?\n/).filter(Boolean).forEach((d) => dirs.add(d.trim()));
  }
  return [...dirs];
}

function probeVersion(cmd, prefix = []) {
  return runCapture(cmd, [...prefix, '--version']);
}

// Runs a command and resolves with its trimmed stdout, or null on failure.
function runCapture(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 20000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
