// Adds what can't live in app.json. Everything else is in app.json.
//
// 1. The app's name and deep-link scheme, and the permission texts that mention the name, come from brand.js
//    (one place to rename the app). Spanish versions go into the iOS Spanish locale.
// 2. Android push (FCM v1) needs Firebase's google-services.json in the build. It isn't committed:
//    on EAS it comes from the file environment variable GOOGLE_SERVICES_JSON (see
//    docs/mobile-app/REGISTRATION-RUNBOOK.md, "Push credentials"); locally, put the file at
//    mobile/google-services.json (git-ignored).
const fs = require('fs');
const path = require('path');
const BRAND = require('./brand');

const withName = (s) => s.replace(/\{app\}/g, BRAND.name);

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'google-services.json');
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(local) ? './google-services.json' : undefined);
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
  };
};
