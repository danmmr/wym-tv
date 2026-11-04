// Connects the detector to Now Playing's poll, so the rules in failureWatch.ts stay
// free of network calls. Never throws: a report must not get in the way of playback.

import {CURRENT_QUEUE, decodeHex} from '../api/wiim';
import type {WiiMClient} from '../api/wiim';
import {recordFailure} from './failureLog';
import {failureWatch} from './failureWatch';

// LinkPlay loop modes 2 and 3 are the shuffled ones. See setLoopMode.
const isShuffled = (loop: string) => loop === '2' || loop === '3';

export async function feedFailureWatch(
  client: WiiMClient,
  status: any,
  metaData: any,
): Promise<void> {
  // No metadata says nothing about the track. Treated as an empty id, it would
  // read as somebody pressing stop.
  if (!metaData) {
    return;
  }
  try {
    const sample = {
      trackId: String(metaData.trackId ?? ''),
      title: decodeHex(status.Title),
      artist: decodeHex(status.Artist),
      album: decodeHex(status.Album),
      status: String(status.status),
      posMs: parseInt(status.curpos, 10) || 0,
      durMs: parseInt(status.totlen, 10) || 0,
      shuffled: isShuffled(String(status.loop)),
      now: Date.now(),
    };
    const failure = failureWatch.observe(sample);
    if (failure) {
      await recordFailure(failure);
    }
    if (!failureWatch.wantsIndex(sample)) {
      return;
    }
    const commands = failureWatch.commandCount;
    const {index} = await client.getQueueIndex(CURRENT_QUEUE);
    if (failureWatch.commandCount !== commands) {
      return;
    }
    const skipped = failureWatch.reportIndex(index);
    if (!skipped.length) {
      return;
    }
    // Tracks that came and went between polls. Only the queue knows what they were.
    const {items} = await client.browseQueue();
    for (const i of skipped) {
      const row = items[i - 1];
      if (row?.trackId.startsWith('/library/metadata/')) {
        await recordFailure({
          trackId: row.trackId,
          title: row.title,
          artist: row.artist,
          album: row.album,
          kind: 'load',
          posMs: 0,
          durMs: 0,
        });
      }
    }
  } catch (e) {
    // Reporting only. The next poll tries again.
  }
}
