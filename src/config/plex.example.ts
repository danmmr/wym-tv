// Copy this file to `plex.ts`. The real `plex.ts` is gitignored because it may
// hold an account token; this example is tracked.
//
// The SERVER ADDRESS is not here — it lives with every other LAN address in
// `hosts.data.json` (see hosts.ts), which deploy.sh reads too. Only the library
// id and the optional secret belong in this file.
//
// token:        OPTIONAL. Leave it commented out unless your Plex server
//               actually requires authentication.
//
//               A server that allows unauthenticated access on the local
//               network serves metadata, artwork AND media parts with no token
//               at all. Carrying one is then a pure liability: Plex keeps
//               honouring a STALE token for metadata, so browsing and artwork
//               look perfectly healthy while media parts answer 503 — not 401.
//               The WiiM fetches those stream URLs itself, treats each 503 as a
//               dead track and advances, so a whole album rips past in seconds.
//               That is the only way this app has ever lost streaming.
//
//               If you do need one: open any item in the Plex web app,
//               "Get Info" -> "View XML", and copy the X-Plex-Token query
//               parameter off the resulting URL. Uncomment the line below and
//               paste it in. deploy.sh will then keep it in sync with
//               ~/.config/plex/token on every build.
// musicSection: numeric id of the music library. Visit
//               <PLEX_BASE_URL>/library/sections?X-Plex-Token=<token> to list
//               them (the token parameter is only needed if yours requires it).
import {PLEX_BASE_URL} from './hosts';

export const PLEX: {
  baseUrl: string;
  token?: string;
  musicSection: number;
} = {
  baseUrl: PLEX_BASE_URL,
  // token: 'YOUR_PLEX_TOKEN_HERE',
  musicSection: 1,
};
