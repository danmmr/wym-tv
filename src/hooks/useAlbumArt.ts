import {useEffect, useRef} from 'react';
import {useDeviceStore} from '../store/deviceStore';
import {usePlayerStore} from '../store/playerStore';
import {WiiMClient} from '../api/wiim';
import {CoverArtResolver} from '../api/coverart';
import {resolveTrackArt, usableArtUri} from './resolveTrackArt';

export const useAlbumArt = () => {
  const resolverRef = useRef(new CoverArtResolver());
  const selectedDevice = useDeviceStore(s => s.selectedDevice);
  const {title, artist, album, albumArt, setAlbumArt} = usePlayerStore();

  useEffect(() => {
    let cancelled = false;

    if (!title || title === 'Unknown') {
      return;
    }

    resolveTrackArt(
      // 1) Ask the device directly — getMetaInfo returns albumArtURI for the
      //    current track (works great for local/Plex libraries).
      async () => {
        if (!selectedDevice) {
          return undefined;
        }
        const meta = await new WiiMClient(selectedDevice.ip).getMetaInfo();
        return usableArtUri(meta?.metaData?.albumArtURI);
      },
      // 2) Fallback: MusicBrainz Cover Art Archive by artist/title.
      () => resolverRef.current.resolveCoverArt(artist, title, album),
      setAlbumArt,
      () => cancelled,
    );

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
