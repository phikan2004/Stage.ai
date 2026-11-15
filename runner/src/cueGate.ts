/** Holds each beat until the presenter reaches it. Beats release in order, once each, even if a cue arrives while an earlier beat is running. */
export class CueGate {
  private pending: string[];
  private gates = new Map<string, { opened: Promise<void>; open: () => void }>();

  constructor(
    beatIds: string[],
    private onRelease: (beatId: string) => void,
  ) {
    this.pending = [...beatIds];
    for (const id of beatIds) {
      let open = () => {};
      const opened = new Promise<void>((resolve) => (open = resolve));
      this.gates.set(id, { opened, open });
    }
  }

  released(beatId: string): Promise<void> {
    return this.gates.get(beatId)?.opened ?? new Promise(() => {});
  }

  /** Opens the next beat. Naming any other beat does nothing. */
  release(beatId = this.pending[0]) {
    if (!beatId || beatId !== this.pending[0]) return;
    this.pending.shift();
    this.gates.get(beatId)?.open();
    this.onRelease(beatId);
  }
}
