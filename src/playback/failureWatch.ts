// Spots tracks the WiiM could not play, from the same samples Now Playing already
// polls. The device never reports a failure, so this works from what it does
// instead. Measured with deliberately broken files on a WiiM Ultra and Mini:
//
//   corrupt or missing file   never reaches 'play'; the next track starts within
//                             1-5s, or with nothing next it stops, keeping the
//                             track's id
//   truncated file            plays what it has, then advances on its own, far
//                             short of the track's length
//   stop from any app         clears the track id
//   skip from any app         looks exactly like a truncated file
//   natural end               position reaches the length
//
// So a skip is the one thing that can pass for a failure. The app's own commands
// are known and discounted below. A skip from the WiiM Home app or a remote can't
// be told apart, and is recorded as "stopped early": that label says only what
// was seen, which is why it is kept separate from "wouldn't load".

export type FailureKind = 'load' | 'early';

export interface PlaybackSample {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  status: string;
  posMs: number;
  durMs: number;
  shuffled: boolean;
  now: number;
}

export interface PlaybackFailure {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  kind: FailureKind;
  posMs: number;
  durMs: number;
}

// Only library tracks: a radio stream or line-in has no file to report.
const LIBRARY_TRACK = /^\/library\/metadata\/\d+$/;

// How close to its length a track must get to count as having finished. Both are
// needed: 10s alone is too strict on a short track, 90% alone too loose on a long
// one.
const END_SLACK_MS = 10000;
const END_FRACTION = 0.9;

// An app command is forgiven for this long. A device takes up to ~5s to change
// track, plus a poll.
const COMMAND_WINDOW_MS = 10000;

// A gap this long between samples means the position is out of date (the poll
// backed off or the app was held up), so an early finish can't be judged from it.
const STALE_SAMPLE_MS = 5000;

// The most queue positions believed to have failed between two polls. A missing
// file takes about a second to fail and a poll is ~1.5s, so a few at most. More
// than that is someone jumping through the queue from another app, not 19 bad files
// in a row. A short jump from another app still can't be told apart.
const MAX_SKIPPED = 3;

export class FailureWatch {
  private current: {
    sample: PlaybackSample;
    attempted: boolean;
    played: boolean;
    posMs: number;
    durMs: number;
    lastAt: number;
    reported: boolean;
  } | null = null;
  private pendingCommands = 0;
  private lastCommandAt = 0;
  private lastIndex: number | null = null;
  private commands = 0;
  private indexChecked = true;

  // The app itself just changed or stopped the track, so the track it left is not
  // a failure. Counted, not a flag: two quick skips leave two tracks. The track
  // being skipped TO is still watched, so playing a broken album is caught.
  //
  // With no track loaded the command leaves nothing behind to forgive. Counting it
  // anyway would excuse the next track instead, which is how a broken album played
  // after a stop went unnoticed.
  //
  // startIndex is the 1-based queue position the command plays from, when it says.
  // A bad first track can fail between polls, and only this shows it was passed.
  noteCommand(now: number, startIndex?: number): void {
    if (this.current) {
      this.pendingCommands += 1;
      this.lastCommandAt = now;
    }
    // Queue positions from before the command no longer compare with later ones.
    this.lastIndex = startIndex === undefined ? null : startIndex - 1;
    this.indexChecked = true;
    this.commands += 1;
  }

  // Lets a caller see that a command arrived while it was waiting on the device,
  // which makes the answer it was waiting for out of date.
  get commandCount(): number {
    return this.commands;
  }

  private takeCommand(now: number): boolean {
    if (now - this.lastCommandAt > COMMAND_WINDOW_MS) {
      this.pendingCommands = 0;
    }
    if (this.pendingCommands > 0) {
      this.pendingCommands -= 1;
      return true;
    }
    return false;
  }

  observe(s: PlaybackSample): PlaybackFailure | null {
    const cur = this.current;
    const isLibrary = LIBRARY_TRACK.test(s.trackId);

    if (cur && s.trackId === cur.sample.trackId) {
      const stale = s.now - cur.lastAt > STALE_SAMPLE_MS;
      cur.lastAt = s.now;
      // A stop that keeps the id came from the device, not from anyone pressing
      // stop, which clears it. It only counts after the track has tried to play:
      // a new queue's first track can read 'stop' for a moment before it loads,
      // and a queue that finished earlier sits at 'stop' for as long as it likes.
      if (s.status === 'stop' && !cur.reported && cur.attempted) {
        cur.reported = true;
        // The stop's own position: a track can finish between polls.
        if (cur.played && s.posMs > 0) {
          cur.posMs = s.posMs;
        }
        return stale || this.takeCommand(s.now) ? null : this.judge();
      }
      this.absorb(s);
      return null;
    }

    // The track changed, or its id was cleared.
    let failure: PlaybackFailure | null = null;
    if (cur && !cur.reported) {
      const stale = s.now - cur.lastAt > STALE_SAMPLE_MS;
      const byApp = this.takeCommand(s.now);
      // An empty id is a stop from some app, so whatever was loading was not
      // given the chance to fail.
      if (!byApp && !stale && isLibrary) {
        failure = this.judge();
      }
    }

    this.current = isLibrary
      ? {
          sample: s,
          attempted: false,
          played: false,
          posMs: 0,
          durMs: 0,
          lastAt: s.now,
          reported: false,
        }
      : null;
    this.indexChecked = false;
    if (this.current) {
      this.absorb(s);
    }
    return failure;
  }

  private absorb(s: PlaybackSample): void {
    const cur = this.current;
    if (!cur) {
      return;
    }
    if (s.status !== 'stop') {
      cur.attempted = true;
    }
    // 'pause' counts: a device can only pause what it managed to start. The
    // duration test matters because a track reads 'play' with no duration for a
    // moment while it is still loading. The position is taken only from these
    // samples, since during 'load' it still holds the previous track's.
    if ((s.status === 'play' || s.status === 'pause') && s.durMs > 0) {
      cur.played = true;
      cur.durMs = s.durMs;
      if (s.posMs > 0) {
        cur.posMs = s.posMs;
      }
    }
  }

  private judge(): PlaybackFailure | null {
    const cur = this.current;
    if (!cur) {
      return null;
    }
    if (!cur.played) {
      return cur.attempted ? this.failure('load') : null;
    }
    const finished =
      cur.durMs - cur.posMs <= END_SLACK_MS ||
      cur.posMs >= cur.durMs * END_FRACTION;
    return finished ? null : this.failure('early');
  }

  private failure(kind: FailureKind): PlaybackFailure {
    const cur = this.current!;
    return {
      trackId: cur.sample.trackId,
      title: cur.sample.title,
      artist: cur.sample.artist,
      album: cur.sample.album,
      kind,
      posMs: cur.posMs,
      durMs: cur.durMs,
    };
  }

  // A poll is ~1.5s and a missing file can fail in under 1s, so a track can come
  // and go between samples. True once per track, when it has settled, to ask for
  // the queue position and catch that with reportIndex.
  wantsIndex(s: PlaybackSample): boolean {
    return (
      !this.indexChecked &&
      !s.shuffled &&
      s.status === 'play' &&
      s.durMs > 0 &&
      !!this.current
    );
  }

  // The 1-based queue positions passed over since the last check. Nothing after a
  // shuffle or a wrap to the start, where the order says nothing, and nothing
  // straight after an app command, which reset the baseline.
  reportIndex(index: number): number[] {
    this.indexChecked = true;
    const last = this.lastIndex;
    this.lastIndex = index > 0 ? index : null;
    if (last === null || index <= last + 1 || index - last - 1 > MAX_SKIPPED) {
      return [];
    }
    const skipped: number[] = [];
    for (let i = last + 1; i < index; i++) {
      skipped.push(i);
    }
    return skipped;
  }
}

// One watch for the app: the commands come from whichever screen sent them, and
// the samples from Now Playing's poll, which keeps running beneath the others.
export const failureWatch = new FailureWatch();

export function noteAppCommand(startIndex?: number): void {
  failureWatch.noteCommand(Date.now(), startIndex);
}
