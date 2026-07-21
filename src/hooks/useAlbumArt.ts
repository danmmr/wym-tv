import {useEffect, useRef} from 'react';
import {useDeviceStore} from '../store/deviceStore';
import {usePlayerStore} from '../store/playerStore';
import {WiiMClient} from '../api/wiim';
import {CoverArtResolver} from '../api/coverart';

export const useAlbumArt = () => {
  const resolverRef = useRef(new CoverArtResolver());
  const selectedDevice = useDeviceStore(s => s.selectedDevice);
  const {title, artist, album, albumArt, setAlbumArt} = usePlayerStore();

  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      if (!title || title === 'Unknown') {
        return;
      }

      // 1) Ask the device directly — getMetaInfo returns albumArtURI for the
      //    current track (works great for local/Plex libraries).
      if (selectedDevice) {
        try {
          const client = new WiiMClient(selectedDevice.ip);
          const meta = await client.getMetaInfo();
          const uri = meta?.metaData?.albumArtURI;
          if (uri && typeof uri === 'string' && uri.startsWith('http')) {
            if (!cancelled) {
              setAlbumArt(uri);
            }
            return;
          }
        } catch (e) {
          // fall through to MusicBrainz
        }
      }

      // 2) Fallback: MusicBrainz Cover Art Archive by artist/title.
      try {
        const artUrl = await resolverRef.current.resolveCoverArt(
          artist,
          title,
          album,
        );
        if (artUrl && !cancelled) {
          setAlbumArt(artUrl);
        }
      } catch (e) {
        // leave placeholder
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
    // Re-resolve whenever the track changes.
    // setAlbumArt is a stable zustand setter; listing it would re-run this fetch
    // on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, artist, album, selectedDevice]);

  return {albumArt};
};
