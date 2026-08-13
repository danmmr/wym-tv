// Every LAN address this project knows about lives in `hosts.data.json`, and this
// module is how the app reads it. Change an IP there and it changes everywhere:
// the Plex server the app pulls from, the WiiM units the Discovery screen
// offers, the subnets a scan sweeps, and (via deploy.sh, which parses the same
// file) the Fire Sticks a build installs to.
//
// It is JSON rather than TypeScript precisely so deploy.sh can read it too — a
// bash script cannot import a .ts module, and duplicating the stick IPs into
// the script is exactly the drift this file exists to prevent. The commentary
// that would otherwise sit next to each value lives here instead.
//
// hosts.data.json is GITIGNORED, like src/config/plex.ts. Private addresses are
// not secrets, but they are this network's layout and are useless to anyone
// else, so the tracked copy is hosts.data.example.json with placeholders. A
// fresh clone copies the example; deploy.sh says so if the real file is absent.
import {WiiMDevice} from '../store/deviceStore';
import hosts from './hosts.data.json';

// Plex Media Server on the LAN.
//
// http:// on purpose — AndroidManifest sets android:usesCleartextTraffic="true",
// which is required for both the album-art thumbnails and the stream URLs we
// hand to the WiiM. Plex's https listener presents a *.plex.direct cert that
// fails hostname verification against a bare IP.
export const PLEX_BASE_URL = `http://${hosts.plex.host}:${hosts.plex.port}`;

// WiiM units with DHCP reservations. These show on the Discovery screen
// instantly, without waiting for a network scan. The id is the IP: it is the
// one thing about a unit that is guaranteed unique and stable here.
export const KNOWN_DEVICES: WiiMDevice[] = hosts.wiimDevices.map(d => ({
  id: d.ip,
  ip: d.ip,
  name: d.name,
  model: d.model,
}));

// Private /24 prefixes a discovery scan sweeps, in order, 1-254 each. The
// home subnet is first so a scan there returns almost immediately.
export const SCAN_SUBNETS: string[] = hosts.scanSubnets;

// Example shown in the "Add by IP" field. Derived from the first scan subnet so
// the hint matches the network the app is actually likely to be on.
export const IP_INPUT_EXAMPLE = `${hosts.scanSubnets[0]}.50`;
