import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mygplink.app',
  appName: 'GP Link',
  webDir: '.',
  server: {
    // In development, use the live server URL.
    // In production builds, the app is served from bundled files.
    // url: 'http://localhost:3000',
    cleartext: false
  },
  ios: {
    scheme: 'GP Link',
    contentInset: 'automatic'
  },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined
    }
  },
  plugins: {
    Browser: {
      // Used for opening Zoom interview links externally
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0f172a'
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true
    }
  }
};

export default config;
