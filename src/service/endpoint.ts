export interface UnixEndpoint {
  readonly transport: "unix";
  readonly socketPath: string;
}
export interface HttpsEndpoint {
  readonly transport: "https";
  readonly url: string;
  readonly basicUsername: string;
  readonly basicPassword: string;
  readonly sendMachineId: boolean;
  /** Omitted means explicitly selected runtime-bundled public roots. */
  readonly tlsCa?: string;
}
export type ServiceEndpoint = UnixEndpoint | HttpsEndpoint;
export type ConfigurationSource =
  | { readonly source: "service"; readonly endpoint: ServiceEndpoint }
  | {
      readonly source: "local";
      readonly configDir: string;
      readonly configPath: string;
      readonly defaultModelsPath: string;
      readonly allowConfigOverride: boolean;
      readonly auditEndpoint?: ServiceEndpoint;
    };
