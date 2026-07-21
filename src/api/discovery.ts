import axios from 'axios';
import {WiiMDevice} from '../store/deviceStore';

// Fast, dedicated probe (short timeout — we're hitting up to 254 hosts).
async function probeIP(ip: string): Promise<WiiMDevice | null> {
  try {
    const res = await axios.get(`https://${ip}/httpapi.asp?command=getStatusEx`, {
      timeout: 1200,
    });
    const info = res.data;
    // getStatusEx returns the friendly name in `ssid`; `project` is the model.
    if (info && (info.DeviceName || info.ssid || info.project)) {
      return {
        id: ip,
        ip,
        name: info.DeviceName || info.ssid || `WiiM Device (${ip})`,
        model: info.project || 'Unknown',
      };
    }
  } catch (e) {
    // not a WiiM device / unreachable
  }
  return null;
}

// Run probes in bounded-concurrency batches so we don't exhaust sockets.
async function scanSubnet(
  prefix: string,
  onFound: (d: WiiMDevice) => void,
  batchSize = 32,
): Promise<void> {
  const hosts: number[] = [];
  for (let i = 1; i <= 254; i++) {
    hosts.push(i);
  }
  for (let i = 0; i < hosts.length; i += batchSize) {
    const batch = hosts.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(h => probeIP(`${prefix}.${h}`)));
    results.forEach(d => {
      if (d) {
        onFound(d);
      }
    });
  }
}

export class DeviceDiscovery {
  // Common private /24 subnets. Full 1-254 scan of each.
  private candidateSubnets = [
    '192.168.2',
    '192.168.1',
    '192.168.0',
    '192.168.10',
    '192.168.50',
    '10.0.0',
    '10.0.1',
    '10.1.1',
    '172.16.0',
  ];

  // Probe a single known IP (used by manual "Add by IP").
  async probeOne(ip: string): Promise<WiiMDevice | null> {
    return probeIP(ip);
  }

  // Scan subnets, reporting devices as they're found via the callback.
  async discover(onFound?: (d: WiiMDevice) => void): Promise<WiiMDevice[]> {
    const found: WiiMDevice[] = [];
    const seen = new Set<string>();
    const collect = (d: WiiMDevice) => {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        found.push(d);
        onFound?.(d);
      }
    };
    // Scan subnets sequentially; stop early once we've found something.
    for (const prefix of this.candidateSubnets) {
      await scanSubnet(prefix, collect);
      if (found.length > 0) {
        break;
      }
    }
    return found;
  }
}
