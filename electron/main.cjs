const { app, BrowserWindow, ipcMain, powerSaveBlocker, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mdns = require('multicast-dns');
const txt = require('dns-txt')();
const loudness = require('loudness');

let ChromecastAPI;
let ChromecastDevice;
let DefaultMediaReceiver;
try {
  ChromecastAPI = require('chromecast-api');
  ChromecastDevice = require('chromecast-api/lib/device');
  DefaultMediaReceiver = require('chromecast-api/apps/default/DefaultMediaReceiver');
} catch (error) {
  ChromecastAPI = null;
  ChromecastDevice = null;
  DefaultMediaReceiver = null;
}

const isDev = !app.isPackaged;
const APP_ICON = path.join(__dirname, 'assets', 'icon.ico');
const PLEX_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Plex-Product': 'Music Complex',
  'X-Plex-Client-Identifier': 'music-complex-desktop',
  'X-Plex-Platform': 'Electron',
  'X-Plex-Device': 'Desktop',
  'X-Plex-Version': '1.0.0',
};
let mainWindow;
let castClient;
let playbackPowerBlockerId = null;
const devices = new Map();
let activeDevice = null;

function logFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'music-complex.log');
}

function writeLog(event, payload = {}) {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`;
  const target = logFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFile(target, line, () => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1060,
    minHeight: 720,
    title: 'Music Complex',
    icon: APP_ICON,
    backgroundColor: '#15171f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.removeMenu();

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function plexTvRequest(path, options = {}) {
  const response = await fetch(`https://plex.tv${path}`, {
    ...options,
    headers: {
      ...PLEX_HEADERS,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Plex returned ${response.status} for ${path}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function plexTvTextRequest(path, options = {}) {
  const response = await fetch(`https://plex.tv${path}`, {
    ...options,
    headers: {
      ...PLEX_HEADERS,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Plex returned ${response.status} for ${path}`);
  }

  return response.text();
}

function decodeXmlValue(value = '') {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(tag = '') {
  const attributes = {};
  const pattern = /([\w:-]+)="([^"]*)"/g;
  let match = pattern.exec(tag);
  while (match) {
    attributes[match[1]] = decodeXmlValue(match[2]);
    match = pattern.exec(tag);
  }
  return attributes;
}

function parsePlexServersXml(xml = '') {
  const servers = [];
  const pattern = /<Server\b[^>]*>/g;
  let match = pattern.exec(xml);
  while (match) {
    servers.push(parseXmlAttributes(match[0]));
    match = pattern.exec(xml);
  }
  return servers;
}

function parsePlexResourcesXml(xml = '') {
  const devices = [];
  const pattern = /<Device\b([^>]*)>([\s\S]*?)<\/Device>|<Device\b([^>]*)\/>/g;
  let match = pattern.exec(xml);
  while (match) {
    const deviceTag = match[0].split('>')[0];
    const body = match[2] || '';
    const device = parseXmlAttributes(deviceTag);
    const connections = [];
    const connectionPattern = /<Connection\b[^>]*\/?>/g;
    let connectionMatch = connectionPattern.exec(body);
    while (connectionMatch) {
      connections.push(parseXmlAttributes(connectionMatch[0]));
      connectionMatch = connectionPattern.exec(body);
    }
    device.Connection = connections;
    devices.push(device);
    match = pattern.exec(xml);
  }
  return devices;
}

function parsePlexResourceDevices(text = '') {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('<')) return parsePlexResourcesXml(trimmed);

  const container = JSON.parse(trimmed);
  return asArray(container.MediaContainer?.Device || container.Device);
}

function plexBoolean(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function preferredConnection(connections = []) {
  return [...connections].sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    if (a.relay !== b.relay) return a.relay ? 1 : -1;
    if ((a.protocol === 'http') !== (b.protocol === 'http')) return a.protocol === 'http' ? -1 : 1;
    return 0;
  })[0] || null;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizePlexResource(resource) {
  const connections = asArray(resource.Connection).map((connection) => ({
    uri: connection.uri,
    protocol: connection.protocol,
    address: connection.address,
    port: connection.port,
    local: plexBoolean(connection.local),
    relay: plexBoolean(connection.relay),
  })).filter((connection) => connection.uri);
  const connection = preferredConnection(connections);

  return {
    id: resource.clientIdentifier || resource.machineIdentifier || resource.name,
    name: resource.name,
    product: resource.product,
    owned: plexBoolean(resource.owned),
    accessToken: resource.accessToken,
    connections,
    uri: connection?.uri || '',
  };
}

function normalizePlexServer(server) {
  const protocol = server.scheme || server.protocol || 'http';
  const address = server.address || server.host;
  const port = server.port || 32400;
  const uri = server.uri || (address ? `${protocol}://${address}:${port}` : '');

  return {
    id: server.machineIdentifier || server.clientIdentifier || server.name,
    name: server.name,
    product: 'Plex Media Server',
    owned: true,
    accessToken: server.accessToken,
    connections: uri ? [{ uri, protocol, address, port, local: true, relay: false }] : [],
    uri,
  };
}

function looksLikePlexServer(resource) {
  const provides = String(resource.provides || '')
    .split(',')
    .map((item) => item.trim().toLowerCase());
  const product = String(resource.product || '').toLowerCase();
  return provides.includes('server') || product.includes('plex media server');
}

function uniqueResources(resources) {
  const seen = new Set();
  return resources.filter((resource) => {
    const key = resource.id || resource.uri || resource.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isIpAddress(host = '') {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function displayKeyForDevice(device) {
  return String(device.friendlyName || device.name || device.host || '')
    .trim()
    .toLowerCase();
}

function shouldReplaceDevice(existing, incoming) {
  if (!existing) return true;
  if (isIpAddress(incoming.host) && !isIpAddress(existing.host)) return true;
  if (!isIpAddress(incoming.host) && isIpAddress(existing.host)) return false;
  if ((incoming.friendlyName || incoming.name).length > (existing.friendlyName || existing.name || '').length) return true;
  return false;
}

function rememberDevice(device) {
  const key = displayKeyForDevice(device);
  if (!key) return;

  const existing = devices.get(key);
  if (shouldReplaceDevice(existing, device)) {
    devices.set(key, device);
    broadcast('cast:devices', deviceSnapshot());
  }
}

function deviceSnapshot() {
  return [...devices.entries()].map(([id, device]) => ({
    id,
    name: device.name,
    friendlyName: device.friendlyName || device.name,
    host: device.host,
  }));
}

function attachCastClient(client) {
  client.on('device', (device) => {
    rememberDevice(device);
  });
}

function ensureCastClient() {
  if (castClient || !ChromecastAPI) return;

  castClient = new ChromecastAPI();
  attachCastClient(castClient);
}

function decodeTxt(data) {
  const decoded = {};
  const chunks = Array.isArray(data) ? data : [data];
  chunks.forEach((chunk) => {
    try {
      Object.assign(decoded, txt.decode(chunk));
    } catch {
      // Ignore malformed discovery packets.
    }
  });
  return decoded;
}

function rememberRawCastDevice(serviceName, raw) {
  if (!ChromecastDevice || !raw.friendlyName || !raw.host) return;
  if (devices.has(serviceName)) return;

  const device = new ChromecastDevice({
    name: serviceName,
    friendlyName: raw.friendlyName,
    host: raw.address || raw.host,
  });

  rememberDevice(device);
}

function localSubnetCandidates() {
  const candidates = new Set();
  const interfaces = os.networkInterfaces();

  Object.values(interfaces).flat().forEach((net) => {
    if (!net || net.internal || net.family !== 'IPv4') return;
    const parts = String(net.address || '').split('.').map(Number);
    const maskParts = String(net.netmask || '').split('.').map(Number);
    if (parts.length !== 4 || maskParts.length !== 4) return;

    const prefix = maskParts.reduce((bits, part) => bits + part.toString(2).split('1').length - 1, 0);
    if (prefix !== 24) return;
    for (let host = 1; host <= 254; host += 1) {
      if (host === parts[3]) continue;
      candidates.add(`${parts[0]}.${parts[1]}.${parts[2]}.${host}`);
    }
  });

  return [...candidates];
}

async function probeCastHttp(ip) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`http://${ip}:8008/setup/eureka_info?params=name,device_info,ssdp_udn`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const info = await response.json();
    const friendlyName = info.name || info.device_info?.name;
    if (!friendlyName) return null;
    return {
      serviceName: info.ssdp_udn || `cast-http-${ip}`,
      friendlyName,
      host: ip,
      modelName: info.device_info?.model_name || '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function runHttpSubnetCastScan() {
  if (!ChromecastDevice) return;
  const candidates = localSubnetCandidates();
  let index = 0;
  const found = [];
  const workerCount = Math.min(48, candidates.length);

  async function worker() {
    while (index < candidates.length) {
      const ip = candidates[index];
      index += 1;
      const result = await probeCastHttp(ip);
      if (!result) continue;
      found.push(result);
      rememberRawCastDevice(result.serviceName, {
        friendlyName: result.friendlyName,
        host: result.host,
        address: result.host,
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  writeLog('cast:http-subnet-scan', { found: found.map((device) => ({ name: device.friendlyName, host: device.host })) });
}

function runRawMdnsScan(duration = 6500) {
  if (!ChromecastDevice) return Promise.resolve();

  return new Promise((resolve) => {
    const browser = mdns();
    const records = new Map();
    const serviceByHost = new Map();

    function getRecord(name) {
      const record = records.get(name) || {};
      records.set(name, record);
      return record;
    }

    function syncDevices() {
      records.forEach((record, name) => {
        if (!name.includes('_googlecast._tcp.local')) return;
        const address = record.address || (record.host ? records.get(record.host)?.address : '');
        rememberRawCastDevice(name, { ...record, address });
      });
    }

    browser.on('response', (response) => {
      [...response.answers, ...response.additionals].forEach((entry) => {
        if (entry.type === 'PTR' && entry.name === '_googlecast._tcp.local') {
          getRecord(entry.data);
        }

        if (entry.type === 'SRV') {
          const record = getRecord(entry.name);
          record.host = entry.data?.target;
          if (record.host) serviceByHost.set(record.host, entry.name);
        }

        if (entry.type === 'TXT') {
          const record = getRecord(entry.name);
          const decoded = decodeTxt(entry.data);
          record.friendlyName = decoded.fn || decoded.n || record.friendlyName;
        }

        if (entry.type === 'A') {
          const record = getRecord(entry.name);
          record.address = entry.data;
          const serviceName = serviceByHost.get(entry.name);
          if (serviceName) getRecord(serviceName).address = entry.data;
        }
      });

      syncDevices();
    });

    browser.query('_googlecast._tcp.local', 'PTR');
    const interval = setInterval(() => browser.query('_googlecast._tcp.local', 'PTR'), 1500);

    setTimeout(() => {
      clearInterval(interval);
      syncDevices();
      browser.destroy();
      resolve();
    }, duration);
  });
}

async function restartCastScan() {
  if (!ChromecastAPI) {
    return {
      supported: false,
      devices: [],
    };
  }

  if (castClient?.destroy) {
    castClient.destroy();
  }
  castClient = null;
  activeDevice = null;
  devices.clear();
  broadcast('cast:devices', []);
  ensureCastClient();
  if (castClient?.update) castClient.update();
  await Promise.all([
    runRawMdnsScan(),
    runHttpSubnetCastScan(),
  ]);

  return {
    supported: true,
    devices: deviceSnapshot(),
  };
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.musiccomplex.desktop');
  playbackPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  writeLog('desktop-background-playback-enabled', { playbackPowerBlockerId });
  createWindow();
  ensureCastClient();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (
    playbackPowerBlockerId !== null
    && powerSaveBlocker.isStarted(playbackPowerBlockerId)
  ) {
    powerSaveBlocker.stop(playbackPowerBlockerId);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('log:write', (_event, event, payload) => {
  writeLog(event, payload);
  return { ok: true };
});

ipcMain.handle('log:path', () => logFilePath());

ipcMain.handle('cast:list', () => {
  writeLog('cast:list', { devices: devices.size });
  ensureCastClient();
  if (castClient?.update) castClient.update();
  runRawMdnsScan(2500);
  runHttpSubnetCastScan();
  return {
    supported: Boolean(ChromecastAPI),
    devices: deviceSnapshot(),
  };
});

ipcMain.handle('cast:rescan', () => restartCastScan());

function findCastDevice(payload = {}) {
  let device = devices.get(payload.id);
  if (!device) {
    device = [...devices.values()].find((candidate) => (
      candidate.host === payload.host || candidate.name === payload.host || candidate.name === payload.id
    ));
  }
  return device;
}

ipcMain.handle('cast:connect', async (_event, payload) => {
  writeLog('cast:connect:start', payload);
  ensureCastClient();
  const device = findCastDevice(payload);

  if (!device) {
    throw new Error('Cast device is no longer available.');
  }

  const previousDevice = activeDevice;
  if (previousDevice && previousDevice !== device && typeof previousDevice.stop === 'function') {
    await new Promise((resolve) => {
      try {
        previousDevice.stop(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  activeDevice = device;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out connecting to ${device.friendlyName || device.name}`));
    }, 10000);

    if (DefaultMediaReceiver && typeof device._connect === 'function' && typeof device._launch === 'function') {
      device._connect((connectError) => {
        if (connectError) {
          clearTimeout(timeout);
          reject(connectError);
          return;
        }

        device._launch(DefaultMediaReceiver, (launchError, player) => {
          clearTimeout(timeout);
          if (launchError) {
            reject(launchError);
            return;
          }
          if (typeof device._onLaunch === 'function') device._onLaunch(player);
          resolve();
        });
      });
      return;
    }

    device.getReceiverStatus((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
  });

  writeLog('cast:connect:success', { device: device.friendlyName || device.name, host: device.host });
  return { ok: true, device: device.friendlyName || device.name };
});

ipcMain.handle('cast:play', async (_event, payload) => {
  writeLog('cast:play:start', {
    title: payload.title,
    device: payload.id || payload.host,
    startTime: payload.startTime || 0,
  });
  ensureCastClient();
  const device = findCastDevice(payload) || activeDevice;

  if (!device) {
    throw new Error('Cast device is no longer available.');
  }

  activeDevice = device;
  const media = {
    url: payload.url,
    contentType: payload.mimeType || 'audio/mpeg',
    cover: payload.coverUrl ? {
      title: payload.title,
      url: payload.coverUrl,
    } : undefined,
  };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out connecting to ${device.friendlyName || device.name}`));
    }, 15000);

    const done = (error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    if (device.client && device.player) {
      device.player.load(media, { startTime: payload.startTime || 0 }, done);
      return;
    }

    device.play(media, { startTime: payload.startTime || 0 }, done);
  });

  writeLog('cast:play:success', { title: payload.title, device: device.friendlyName || device.name });
  return { ok: true, device: device.friendlyName || device.name };
});

ipcMain.handle('cast:control', async (_event, action, value) => {
  writeLog('cast:control:start', { action, value });
  if (!activeDevice) throw new Error('No active cast device.');

  await new Promise((resolve, reject) => {
    const done = (error) => (error ? reject(error) : resolve());
    if (action === 'pause') activeDevice.pause(done);
    else if (action === 'resume') activeDevice.resume(done);
    else if (action === 'stop') activeDevice.stop(done);
    else if (action === 'seek') activeDevice.seekTo(value || 0, done);
    else if (action === 'volume') activeDevice.setVolume(value, done);
    else reject(new Error(`Unsupported cast action: ${action}`));
  });

  writeLog('cast:control:success', { action, value });
  return { ok: true };
});

ipcMain.handle('cast:disconnect', async () => {
  writeLog('cast:disconnect:start', { device: activeDevice?.friendlyName || activeDevice?.name });
  const device = activeDevice;
  activeDevice = null;

  if (!device) return { ok: true };

  await new Promise((resolve) => {
    try {
      if (typeof device.stop === 'function') {
        device.stop(() => resolve());
        return;
      }
      if (device.client) device.client.close();
      resolve();
    } catch {
      resolve();
    }
  });

  writeLog('cast:disconnect:success', {});
  return { ok: true };
});

ipcMain.handle('cast:status', async () => {
  writeLog('cast:status:start', { device: activeDevice?.friendlyName || activeDevice?.name || '' });
  if (!activeDevice) throw new Error('No active cast device.');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      writeLog('cast:status:timeout', { device: activeDevice?.friendlyName || activeDevice?.name || '' });
      reject(new Error('Timed out reading cast status.'));
    }, 3500);

    activeDevice.getStatus((error, status) => {
      clearTimeout(timeout);
      if (error) {
        writeLog('cast:status:error', {
          device: activeDevice?.friendlyName || activeDevice?.name || '',
          message: error.message,
        });
        reject(error);
        return;
      }

      writeLog('cast:status:success', {
        device: activeDevice?.friendlyName || activeDevice?.name || '',
        currentTime: status?.currentTime || 0,
        duration: status?.media?.duration || 0,
        playerState: status?.playerState || '',
      });
      resolve({
        currentTime: status?.currentTime || 0,
        duration: status?.media?.duration || 0,
        playerState: status?.playerState || '',
      });
    });
  });
});

ipcMain.handle('system-volume:set', async (_event, value) => {
  const next = Math.max(0, Math.min(100, Math.round(Number(value) * 100)));
  await loudness.setVolume(next);
  return { ok: true, volume: next };
});

ipcMain.handle('system-volume:get', async () => {
  const current = await loudness.getVolume();
  return { volume: current };
});

ipcMain.handle('plex-auth:create-pin', async () => {
  const pin = await plexTvRequest('/api/v2/pins?strong=true', { method: 'POST' });
  const params = new URLSearchParams({
    clientID: PLEX_HEADERS['X-Plex-Client-Identifier'],
    code: pin.code,
    'context[device][product]': PLEX_HEADERS['X-Plex-Product'],
  });
  const url = `https://app.plex.tv/auth#?${params.toString()}`;
  await shell.openExternal(url);
  return { id: pin.id, code: pin.code, url };
});

ipcMain.handle('plex-auth:poll-pin', async (_event, id) => {
  const pin = await plexTvRequest(`/api/v2/pins/${id}`);
  return { token: pin.authToken || null };
});

ipcMain.handle('plex-auth:resources', async (_event, token) => {
  if (!token) throw new Error('Missing Plex account token.');
  const params = new URLSearchParams({
    includeHttps: '1',
    includeRelay: '1',
    'X-Plex-Token': token,
  });

  const resourcesText = await plexTvTextRequest(`/api/resources?${params.toString()}`, {
    headers: {
      Accept: 'application/json,application/xml,text/xml,*/*',
      'X-Plex-Token': token,
    },
  });
  const devices = parsePlexResourceDevices(resourcesText);
  const resourcesFromDevices = devices
    .filter((resource) => looksLikePlexServer(resource) && resource.accessToken)
    .map(normalizePlexResource)
    .filter((resource) => resource.uri);
  let fallbackServers = [];

  if (!resourcesFromDevices.length) {
    const serverXml = await plexTvTextRequest(`/pms/servers?X-Plex-Token=${encodeURIComponent(token)}`, {
      headers: {
        Accept: 'application/xml,text/xml,*/*',
        'X-Plex-Token': token,
      },
    });
    fallbackServers = parsePlexServersXml(serverXml)
      .filter((server) => server.accessToken)
      .map(normalizePlexServer)
      .filter((server) => server.uri);
  }

  const resources = uniqueResources([...resourcesFromDevices, ...fallbackServers]);
  return {
    resources,
    diagnostics: {
      devices: devices.length,
      resourceServers: resourcesFromDevices.length,
      fallbackServers: fallbackServers.length,
    },
  };
});
