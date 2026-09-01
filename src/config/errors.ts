export class ConfigError extends Error {
  readonly source: string;
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[], cause?: unknown) {
    super(
      `Invalid pi-sandbox configuration in ${source}:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
      {
        cause,
      },
    );
    this.name = "ConfigError";
    this.source = source;
    this.issues = Object.freeze([...issues]);
  }
}
