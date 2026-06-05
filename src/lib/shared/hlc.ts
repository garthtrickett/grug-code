/**
 * Hybrid Logical Clock (HLC) Implementation
 * 
 * An HLC timestamp is composed of:
 * 1. physical: The maximum physical time (ms) seen so far.
 * 2. counter: A counter for events that occur within the same millisecond.
 * 3. nodeId: A unique identifier for the device/user to break ties.
 * 
 * The packed format is "timestamp:counter:nodeId" which is lexicographically sortable.
 */

export interface Hlc {
  readonly physical: number;
  readonly counter: number;
  readonly nodeId: string;
}

/**
 * Packs an HLC object into a sortable string.
 * Timestamp is padded to 13 digits (standard JS ms).
 * Counter is padded to 4 hex digits (0-65535).
 */
export const packHlc = (hlc: Hlc): string => {
  const ts = hlc.physical.toString().padStart(13, "0");
  const count = hlc.counter.toString(16).padStart(4, "0");
  return `${ts}:${count}:${hlc.nodeId}`;
};

/**
 * Unpacks a sortable string into an HLC object.
 */
export const unpackHlc = (serialized: string): Hlc => {
  const parts = serialized.split(":");
  if (parts.length < 3) {
    throw new Error(`Invalid HLC format: ${serialized}`);
  }
  return {
    physical: parseInt(parts[0] || "0", 10),
    counter: parseInt(parts[1] || "0", 16),
    nodeId: parts.slice(2).join(":"),
  };
};

/**
 * Generates an initial HLC for a new node.
 */
export const initHlc = (nodeId: string, now: number = Date.now()): Hlc => ({
  physical: now,
  counter: 0,
  nodeId,
});

/**
 * Ticks the local HLC forward. 
 * Called whenever a new local event (mutation) occurs.
 */
export const tickHlc = (local: Hlc, now: number = Date.now()): Hlc => {
  const newPhysical = Math.max(local.physical, now);

  if (newPhysical === local.physical) {
    return {
      ...local,
      counter: local.counter + 1,
    };
  }

  return {
    physical: newPhysical,
    counter: 0,
    nodeId: local.nodeId,
  };
};

/**
 * Updates the local HLC based on a remote timestamp.
 * Called whenever a mutation is received from another node (Sync).
 */
export const receiveHlc = (local: Hlc, remoteSerialized: string, now: number = Date.now()): Hlc => {
  const remote = unpackHlc(remoteSerialized);
  const newPhysical = Math.max(local.physical, remote.physical, now);

  if (newPhysical === local.physical && newPhysical === remote.physical) {
    return {
      ...local,
      counter: Math.max(local.counter, remote.counter) + 1,
    };
  }

  if (newPhysical === local.physical) {
    return {
      ...local,
      counter: local.counter + 1,
    };
  }

  if (newPhysical === remote.physical) {
    return {
      ...local,
      physical: newPhysical,
      counter: remote.counter + 1,
    };
  }

  return {
    ...local,
    physical: newPhysical,
    counter: 0,
  };
};
