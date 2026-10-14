import { execFileSync } from "node:child_process";

const MAXIMUM_LOOKUP_BYTES = 65_536;
const MACHINE_ID_ERROR = "Unable to resolve the machine ID from the operating system";
const UUID_PROPERTY =
  /^[ \t]*"IOPlatformUUID" = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[ \t]*$/iu;

function invalid(): never {
  throw new Error(MACHINE_ID_ERROR);
}

/** Read the macOS hardware UUID, independently of the invoking account or environment. */
export function readMachineId(): string {
  try {
    if (process.platform !== "darwin") invalid();
    const result = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: MAXIMUM_LOOKUP_BYTES,
    });
    if (result.length === 0 || result.length > MAXIMUM_LOOKUP_BYTES) invalid();
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result);
    if (
      [...output].some(
        (character) => !["\n", "\t"].includes(character) && /\p{Cc}/u.test(character),
      )
    ) {
      invalid();
    }
    const properties = output.split("\n").filter((line) => line.includes('"IOPlatformUUID"'));
    if (properties.length !== 1) invalid();
    const match = UUID_PROPERTY.exec(properties[0]!);
    if (match === null || match[1] === "00000000-0000-0000-0000-000000000000") invalid();
    return match[1]!.toUpperCase();
  } catch {
    // Registry output can include hardware identifiers; never attach output or the original error.
    throw new Error(MACHINE_ID_ERROR);
  }
}

/** Bind one lazy lookup, including a failure, to one managed application startup. */
export function createMachineIdResolver(getMachineId: () => string = readMachineId): () => string {
  let result: { readonly value: string } | { readonly error: unknown } | undefined;
  return () => {
    if (result === undefined) {
      try {
        result = { value: getMachineId() };
      } catch (error) {
        result = { error };
      }
    }
    if ("error" in result) throw result.error;
    return result.value;
  };
}
