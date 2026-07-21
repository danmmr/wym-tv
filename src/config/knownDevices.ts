import {WiiMDevice} from '../store/deviceStore';

// Hardcoded WiiM units (DHCP reservations on the LAN). These show up instantly
// on the Discovery screen without waiting for a network scan. Edit this list to
// add/remove devices.
export const KNOWN_DEVICES: WiiMDevice[] = [
  {id: '192.168.2.20', ip: '192.168.2.20', name: 'WiiM Ultra', model: 'WiiM_Ultra'},
  {id: '192.168.2.31', ip: '192.168.2.31', name: 'WiiM Mini', model: 'Muzo_Mini'},
];
