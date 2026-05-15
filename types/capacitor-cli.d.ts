declare module '@capacitor/cli' {
  export interface CapacitorConfig {
    appId?: string;
    appName?: string;
    webDir?: string;
    server?: Record<string, unknown>;
    ios?: Record<string, unknown>;
    android?: Record<string, unknown>;
    plugins?: Record<string, unknown>;
  }
}
