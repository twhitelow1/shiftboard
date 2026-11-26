// Adds what can't live in app.json. Everything else is in app.json.
//
// 1. The app's name and deep-link scheme, and the permission texts that mention the name, come from brand.js
//    (one place to rename the app). Spanish versions go into the iOS Spanish locale.
// 2. Android push (FCM v1) needs Firebase's google-services.json in the build. It isn't committed:
//    on EAS it comes from the file environment variable GOOGLE_SERVICES_JSON (see
//    docs/mobile-app/REGISTRATION-RUNBOOK.md, "Push credentials"); locally, put the file at
//    mobile/google-services.json (git-ignored).
// 3. EAS (Expo's cloud) knows the app as @dublow-digital/shiftboard (owner + slug in app.json). Its project ID is
//    extra.eas.projectId in app.json once known; until then the GitHub workflow looks it up with EXPO_TOKEN and
//    passes it as EAS_PROJECT_ID. With it, EAS Update publishes the app (updates.url), and runtimeVersion
//    "sdkVersion" (exposdk:58.0.0) is what Expo Go on a phone needs to open those updates
//    (.github/workflows/expo-preview.yml, docs/mobile-app/DEVELOPING.md "On a phone, no computer").
const fs = require('fs');
const path = require('path');
const BRAND = require('./brand');

const withName = (s) => s.replace(/\{app\}/g, BRAND.name);

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'google-services.json');
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(local) ? './google-services.json' : undefined);
  const projectId = process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId || undefined;
  // The commit being built, sent with error reports (src/lib/errors.ts): Vercel sets it for /app, EAS for its builds.
  const commit = String(process.env.VERCEL_GIT_COMMIT_SHA || process.env.EAS_BUILD_GIT_COMMIT_HASH || '').slice(0, 7);
  const en = BRAND.permissions.en;
  const es = BRAND.permissions.es;
  const plugins = (config.plugins || []).map((p) => (Array.isArray(p) && p[0] === 'expo-image-picker'
    ? ['expo-image-picker', { ...p[1], cameraPermission: withName(en.camera), photosPermission: withName(en.photos) }]
    : p));
  return {
    ...config,
    name: BRAND.name,
    scheme: BRAND.scheme,
    plugins,
    locales: {
      ...(config.locales || {}),
      es: {
        ios: {
          CFBundleDisplayName: BRAND.name,
          NSCameraUsageDescription: withName(es.camera),
          NSPhotoLibraryUsageDescription: withName(es.photos),
        },
      },
    },
    web: { ...config.web, name: BRAND.name, shortName: BRAND.name },
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
    runtimeVersion: { policy: 'sdkVersion' },
    // The browser version a ShiftBoard server hosts at /app is built with WEB_BASE_URL=/app (npm run build:app).
    ...(process.env.WEB_BASE_URL ? { experiments: { ...config.experiments, baseUrl: process.env.WEB_BASE_URL } } : {}),
    ...(commit ? { extra: { ...config.extra, commit } } : {}),
    ...(projectId ? {
      extra: { ...config.extra, ...(commit ? { commit } : {}), eas: { ...config.extra?.eas, projectId } },
      updates: { ...config.updates, url: `https://u.expo.dev/${projectId}` },
    } : {}),
  };
};
