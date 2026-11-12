import {
  MetaGate,
  REFRESH_EVERY,
  SETTLE_POLLS,
  statusSignature,
} from '../src/playback/metaGate';

const status = (over: Record<string, string> = {}) => ({
  Title: 'AA',
  Artist: 'BB',
  Album: 'CC',
  totlen: '285000',
  plicurr: '3',
  status: 'play',
  curpos: '1000',
  vol: '40',
  mute: '0',
  ...over,
});

// Run one poll the way Now Playing does: ask the gate, fetch if told to.
function poll(gate: MetaGate, s: any, answer: any): boolean {
  const fetched = gate.shouldFetch(statusSignature(s));
  if (fetched) {
    gate.store(answer);
  }
  return fetched;
}

describe('statusSignature', () => {
  it('ignores position, volume and mute', () => {
    expect(statusSignature(status())).toBe(
      statusSignature(status({curpos: '99000', vol: '10', mute: '1'})),
    );
  });

  it.each(['Title', 'Artist', 'Album', 'totlen', 'plicurr', 'status'])(
    'changes with %s',
    field => {
      expect(statusSignature(status())).not.toBe(
        statusSignature(status({[field]: 'x'})),
      );
    },
  );

  it('survives a status with fields missing', () => {
    expect(statusSignature({})).toBe('|||||');
    expect(statusSignature(undefined)).toBe('|||||');
  });
});

describe('MetaGate', () => {
  it('fetches on the first poll', () => {
    const gate = new MetaGate();
    expect(poll(gate, status(), {trackId: 't1'})).toBe(true);
    expect(gate.metaData).toEqual({trackId: 't1'});
  });

  it('keeps asking briefly after a change, then goes quiet', () => {
    const gate = new MetaGate();
    const fetches: boolean[] = [];
    for (let i = 0; i < 1 + SETTLE_POLLS + 3; i++) {
      fetches.push(poll(gate, status({curpos: String(i * 1500)}), {id: 1}));
    }
    expect(fetches).toEqual([
      true,
      ...Array(SETTLE_POLLS).fill(true),
      false,
      false,
      false,
    ]);
  });

  it('holds the answer between fetches', () => {
    const gate = new MetaGate();
    for (let i = 0; i < 1 + SETTLE_POLLS; i++) {
      poll(gate, status(), {trackId: 't1'});
    }
    expect(poll(gate, status(), {trackId: 'WRONG'})).toBe(false);
    expect(gate.metaData).toEqual({trackId: 't1'});
  });

  it('fetches at once when the track changes', () => {
    const gate = new MetaGate();
    for (let i = 0; i < 1 + SETTLE_POLLS + 2; i++) {
      poll(gate, status(), {trackId: 't1'});
    }
    expect(poll(gate, status({Title: 'DD'}), {trackId: 't2'})).toBe(true);
    expect(gate.metaData).toEqual({trackId: 't2'});
  });

  it('corrects an answer that trailed the status change', () => {
    const gate = new MetaGate();
    for (let i = 0; i < 1 + SETTLE_POLLS + 2; i++) {
      poll(gate, status(), {trackId: 't1'});
    }
    // The device still reports the old track on the poll that sees the change.
    poll(gate, status({Title: 'DD'}), {trackId: 't1'});
    expect(gate.metaData).toEqual({trackId: 't1'});
    expect(poll(gate, status({Title: 'DD'}), {trackId: 't2'})).toBe(true);
    expect(gate.metaData).toEqual({trackId: 't2'});
  });

  it('keeps asking every poll while the device has no metadata', () => {
    const gate = new MetaGate();
    for (let i = 0; i < SETTLE_POLLS + 8; i++) {
      expect(poll(gate, status({status: 'stop'}), undefined)).toBe(true);
    }
    expect(gate.metaData).toBeUndefined();
  });

  it('drops the held answer when an ask comes back empty', () => {
    const gate = new MetaGate();
    poll(gate, status(), {trackId: 't1'});
    poll(gate, status(), undefined);
    expect(gate.metaData).toBeUndefined();
  });

  it('refreshes periodically even when nothing changes', () => {
    const gate = new MetaGate();
    for (let i = 0; i < 1 + SETTLE_POLLS; i++) {
      poll(gate, status(), {trackId: 't1'});
    }
    const quiet: boolean[] = [];
    for (let i = 0; i < REFRESH_EVERY * 2; i++) {
      quiet.push(poll(gate, status(), {trackId: 't1'}));
    }
    const at = quiet.map((f, i) => (f ? i + 1 : 0)).filter(Boolean);
    expect(at).toEqual([REFRESH_EVERY, REFRESH_EVERY * 2]);
  });
});
