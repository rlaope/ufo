import os from "node:os";
import {
  type MachineFingerprint,
  MachineFingerprintSchema,
  type PowerSource,
} from "../../domain/index.js";
import { DOCKER_PROBE_TIMEOUT_MS, execBounded } from "../jobs/process.js";

type Awaitable<T> = T | Promise<T>;

/** The Docker Desktop VM's resources, or why they are unknown. */
export type DockerVm = NonNullable<MachineFingerprint["dockerVm"]>;

/**
 * Sources of each fingerprint field. Everything but `powerSource` defaults to the local machine;
 * the power source comes from the measurement hygiene probe.
 */
export interface FingerprintReaders {
  powerSource: () => Awaitable<PowerSource>;
  cpus?: () => readonly { model: string }[];
  totalMemoryBytes?: () => number;
  os?: () => { platform: string; release: string; arch: string };
  /** Runtimes the target uses, e.g. `{ java: "25" }`. Packs provide them; defaults to none. */
  runtimes?: () => Awaitable<Record<string, string>>;
  /** Defaults to `readDockerDesktopVm`. */
  dockerVm?: () => Awaitable<DockerVm | undefined>;
}

/**
 * Describes the machine for an evidence bundle: CPU model and cores, RAM, OS and kernel release,
 * runtimes, power source, and the Docker Desktop VM when present. It has no hostname or
 * username field; bundles are published.
 */
export async function collectFingerprint(readers: FingerprintReaders): Promise<MachineFingerprint> {
  const cpus = (readers.cpus ?? os.cpus)();
  const system = readers.os
    ? readers.os()
    : { platform: process.platform, release: os.release(), arch: process.arch };
  const [powerSource, runtimes, dockerVm] = await Promise.all([
    readers.powerSource(),
    readers.runtimes?.() ?? {},
    (readers.dockerVm ?? readDockerDesktopVm)(),
  ]);
  return MachineFingerprintSchema.parse({
    cpuModel: cpus[0]?.model.trim() || "unknown",
    cpuCores: cpus.length > 0 ? cpus.length : os.availableParallelism(),
    memoryBytes: (readers.totalMemoryBytes ?? os.totalmem)(),
    os: system,
    runtimes,
    powerSource,
    ...(dockerVm === undefined ? {} : { dockerVm }),
  });
}

const DockerInfoSchema = MachineFingerprintSchema.shape.dockerVm.unwrap().options[0];

/**
 * CPUs and memory of the Docker Desktop VM, from `docker info`. `undefined` when Docker is
 * missing, its daemon is down, or it runs natively (Linux), where containers share the host.
 * `docker info` gets `DOCKER_PROBE_TIMEOUT_MS`; past it, the VM is `unknown` with the reason.
 */
export async function readDockerDesktopVm(): Promise<DockerVm | undefined> {
  try {
    const { stdout } = await execBounded(
      "docker",
      ["info", "--format", "{{.OperatingSystem}}\t{{.NCPU}}\t{{.MemTotal}}"],
      DOCKER_PROBE_TIMEOUT_MS,
    );
    const [system = "", cpus, memory] = stdout.trim().split("\t");
    if (!system.includes("Docker Desktop")) return undefined;
    const parsed = DockerInfoSchema.safeParse({ cpus: Number(cpus), memoryBytes: Number(memory) });
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ETIMEDOUT") return undefined;
    return {
      unknown: true,
      reason: `docker info did not finish within ${DOCKER_PROBE_TIMEOUT_MS / 1000} s`,
    };
  }
}
