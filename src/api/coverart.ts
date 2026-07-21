import axios from 'axios';

const MB_API = 'https://musicbrainz.org/ws/2';
const COVERART_API = 'https://coverartarchive.org';

export class CoverArtResolver {
  private cache: Map<string, string> = new Map();

  async resolveCoverArt(
    artist: string,
    title: string,
    album: string,
  ): Promise<string | null> {
    const cacheKey = `${artist}|${title}|${album}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) || null;
    }

    try {
      // Try MusicBrainz Cover Art Archive
      const art = await this.searchMusicBrainz(artist, title, album);
      if (art) {
        this.cache.set(cacheKey, art);
        return art;
      }
    } catch (error) {
      console.warn('MusicBrainz lookup failed:', error);
    }

    return null;
  }

  private async searchMusicBrainz(
    artist: string,
    title: string,
    album: string,
  ): Promise<string | null> {
    try {
      // Search for recording
      const query = `${title} AND artist:${artist}`;
      const response = await axios.get(`${MB_API}/recording`, {
        params: {
          query,
          fmt: 'json',
        },
        timeout: 5000,
      });

      if (response.data.recordings && response.data.recordings.length > 0) {
        const recording = response.data.recordings[0];

        // Try to get release with cover art
        if (recording.releases && recording.releases.length > 0) {
          for (const release of recording.releases) {
            const coverArtUrl = await this.getCoverArtFromRelease(release.id);
            if (coverArtUrl) {
              return coverArtUrl;
            }
          }
        }
      }
    } catch (error) {
      console.warn('MusicBrainz search failed:', error);
    }

    return null;
  }

  private async getCoverArtFromRelease(releaseId: string): Promise<string | null> {
    try {
      const response = await axios.get(`${COVERART_API}/release/${releaseId}/front`, {
        timeout: 5000,
        validateStatus: (status) => status === 200 || status === 307,
      });

      if (response.status === 200) {
        return `${COVERART_API}/release/${releaseId}/front`;
      }
    } catch (error) {
      // No cover art for this release
    }

    return null;
  }

  clearCache() {
    this.cache.clear();
  }
}
