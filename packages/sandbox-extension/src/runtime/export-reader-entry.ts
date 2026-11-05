import { parseExportReaderConfiguration } from "./export/protocol.js";
import { runSandboxExportReader } from "./export/reader.js";

try {
  if (process.argv.length !== 3) throw new Error("export_reader_configuration_invalid");
  await runSandboxExportReader(parseExportReaderConfiguration(process.argv[2]!));
} catch {
  process.stderr.write("pi-sandbox-export-reader: startup failed\n");
  process.exitCode = 70;
}
