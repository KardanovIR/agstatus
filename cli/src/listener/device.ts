import crypto from 'crypto';
import fs from 'fs';
import type { MachineState } from './types';

/**
 * Whether machine.json belongs to the computer reading it.
 *
 * A state directory copied to a second machine (a restored backup, a migrated
 * home, a synced folder) carries its machine id along, and two listeners then
 * answer to one id. The installer used to catch that by recording
 * `os.hostname()` and minting a new id whenever it no longer matched. On macOS
 * the hostname is not the machine's, though: it follows the network. One Mac
 * wrote "Mac" into machine.json on 2026-10-05 and read "MacBook-Pro-5.local"
 * on 2026-10-19 (its LocalHostName and ComputerName had not changed), so the
 * 1.6.2 upgrade gave that one Mac a second id: a duplicate machine on the
 * board, and Focus offline on every card last reported under the old one. It
 * would have happened again on any reinstall from another network.
 *
 * So copies are told apart by an identifier of the hardware, which no
 * network, rename or reinstall changes: IOPlatformUUID on macOS,
 * /etc/machine-id on Linux. Only a salted hash of it is ever written (see
 * deviceHash), and the hostname stays in the file as a hint for people,
 * never compared.
 */

/** Fixed system binary; never resolved via PATH. */
export const IOREG = '/usr/sbin/ioreg';
export const IOREG_ARGS = ['-rd1', '-c', 'IOPlatformExpertDevice'];
/** ioreg needs nothing from our environment, and gets nothing of it. */
const IOREG_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

/** systemd's machine id, then the D-Bus copy of it on systems without systemd. */
export const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;

const IOREG_UUID_RE =
  /^\s*"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"\s*$/m;
/** 32 lowercase hex, machine-id(5); "uninitialized" and an empty file do not match. */
const MACHINE_ID_RE = /^[0-9a-f]{32}$/;
export const DEVICE_HASH_RE = /^[0-9a-f]{64}$/;

/** Structurally the installer's Exec: argv only, and `env` replaces ours. */
export type DeviceExec = (
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => Promise<{ code: number; stdout: string }>;

/** The IOPlatformUUID line of `ioreg -rd1 -c IOPlatformExpertDevice`, lowercased; null when there is none. */
export function parseIoregUuid(stdout: string): string | null {
  const m = IOREG_UUID_RE.exec(stdout);
  return m ? m[1].toLowerCase() : null;
}

/**
 * This computer's hardware identifier, lowercased, or null when it cannot be
 * read. Never throws, and the value is never logged or written anywhere: its
 * only use is as an input to deviceHash().
 *
 * Windows has no reader because nothing there needs one: `listener install`,
 * the one writer of machine.json, refuses every platform but macOS. Should
 * that change, the counterpart is MachineGuid under
 * HKLM\SOFTWARE\Microsoft\Cryptography.
 */
export async function readDeviceId(
  platform: NodeJS.Platform,
  exec: DeviceExec,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8')
): Promise<string | null> {
  try {
    if (platform === 'darwin') {
      const res = await exec(IOREG, IOREG_ARGS, IOREG_ENV);
      return res.code === 0 ? parseIoregUuid(res.stdout) : null;
    }
    if (platform === 'linux') {
      for (const file of MACHINE_ID_FILES) {
        let id: string;
        try {
          id = readFile(file).trim().toLowerCase();
        } catch {
          continue;
        }
        if (MACHINE_ID_RE.test(id)) return id;
      }
    }
  } catch {
    /* a reader that fails is the same answer as one that finds nothing */
  }
  return null;
}

/**
 * What machine.json stores in place of the hardware id: the lowercase hex
 * SHA-256 of a fixed tag, the file's own machine id and the hardware id. The
 * machine id is the salt — random per install, already in the file and never
 * sent anywhere — so the hash is useless for linking one computer across
 * installs, apps or anything else, and the tag keeps it from ever coinciding
 * with machineKey(), which hashes `machineId + "\n" + base`.
 */
export function deviceHash(machineId: string, deviceId: string): string {
  return crypto.createHash('sha256').update(`agstatus-device-v1\n${machineId}\n${deviceId}`).digest('hex');
}

/**
 * - `match`: the file was written on this computer.
 * - `mismatch`: written on another one — a copied state directory.
 * - `unrecorded`: written before the hash existed (every install up to 1.6.2),
 *   so there is nothing to compare; the installer adopts this computer.
 * - `unreadable`: this computer's id could not be read, so nothing can be said.
 *
 * A changed hostname is none of these, and never a reason for a new id.
 */
export type DeviceVerdict = 'match' | 'mismatch' | 'unrecorded' | 'unreadable';

export function deviceVerdict(machine: MachineState, deviceId: string | null): DeviceVerdict {
  if (deviceId === null) return 'unreadable';
  if (!machine.deviceHash) return 'unrecorded';
  return deviceHash(machine.machineId, deviceId) === machine.deviceHash ? 'match' : 'mismatch';
}
