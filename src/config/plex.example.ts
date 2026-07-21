// Copy this file to `plex.ts` and fill in your own server details. The real
// `plex.ts` is gitignored because it holds an account token.
//
// baseUrl:      LAN address of the Plex Media Server. http:// is fine and is
//               what we use — AndroidManifest sets android:usesCleartextTraffic
//               ="true", which is required for both the album-art thumbnails and
//               the stream URLs we hand to the WiiM.
// token:        X-Plex-Token for the account. Find it by opening any item in the
//               Plex web app, "Get Info" -> "View XML", and copying the
//               X-Plex-Token query parameter off the resulting URL.
// musicSection: numeric id of the music library. Visit
//               <baseUrl>/library/sections?X-Plex-Token=<token> to list them.
export const PLEX = {
  baseUrl: 'http://192.168.1.100:32400',
  token: 'YOUR_PLEX_TOKEN_HERE',
  musicSection: 1,
};
