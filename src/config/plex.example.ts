// Copy this file to `plex.ts` and fill in your own token. The real `plex.ts` is
// gitignored because it holds an account token; this example is tracked.
//
// The SERVER ADDRESS is not here — it lives with every other LAN address in
// `hosts.data.json` (see hosts.ts), which deploy.sh reads too. Only the secret and
// the library id belong in this file.
//
// token:        X-Plex-Token for the account. Find it by opening any item in the
//               Plex web app, "Get Info" -> "View XML", and copying the
//               X-Plex-Token query parameter off the resulting URL.
// musicSection: numeric id of the music library. Visit
//               <PLEX_BASE_URL>/library/sections?X-Plex-Token=<token> to list them.
import {PLEX_BASE_URL} from './hosts';

export const PLEX = {
  baseUrl: PLEX_BASE_URL,
  token: 'YOUR_PLEX_TOKEN_HERE',
  musicSection: 1,
};
