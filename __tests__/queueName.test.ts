import {queueDisplayName, QUEUE_DISPLAY_NAME} from '../src/api/wiim';

// The queue's ListName on the WiiM is still "WiiMTV" on purpose: it is the
// handle appendQueue and playIndex address, so renaming it would orphan a
// playing queue at upgrade time. Only the label shown to the user changed.
describe('queueDisplayName', () => {
  it('shows the app name for our own queue', () => {
    expect(queueDisplayName('WiiMTV')).toBe('WyM TV');
    expect(queueDisplayName('WiiMTV')).toBe(QUEUE_DISPLAY_NAME);
  });

  it('leaves a queue pushed by another app under its own name', () => {
    // Where a queue came from is the only thing this line can tell you, so it
    // must not be overwritten with ours.
    expect(queueDisplayName('Plex')).toBe('Plex');
    expect(queueDisplayName('My Playlist')).toBe('My Playlist');
  });

  it('matches exactly, not loosely', () => {
    // A queue merely containing the handle is somebody else's.
    expect(queueDisplayName('WiiMTV Radio')).toBe('WiiMTV Radio');
    expect(queueDisplayName('wiimtv')).toBe('wiimtv');
    expect(queueDisplayName(' WiiMTV')).toBe(' WiiMTV');
  });

  it('passes an empty name straight through', () => {
    // browseQueue returns '' when there is no queue; the header renders the
    // track count alone in that case rather than a stray app name.
    expect(queueDisplayName('')).toBe('');
  });
});
