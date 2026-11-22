// The app's name, in one place. "ShiftBoard" is a working name: to rename the app, change `name` (and `scheme`
// if the invite links should change too) here, then rebuild. See docs/mobile-app/DEVELOPING.md, "Renaming the app".
//
// - app.config.js puts these into the name under the icon (iOS and Android, English and Spanish), the deep-link
//   scheme and the camera / photo permission texts the phone shows.
// - The app's own words (src/i18n/en.ts and es.ts) say {app} wherever the name appears; translate() fills it in.
// - The store listing text lives in docs/mobile-app/STORE-LISTING.md (update it by hand).
//
// Not here on purpose: `slug` (the EAS project), the iOS bundle ID and the Android package (app.json). Those are
// the app's identity in Expo and the stores, are never shown to people, and can't change after the first release.
// The keys the app keeps on the phone ("shiftboard.server" …) stay as they are too, so nobody gets signed out.
module.exports = {
  /** The name people see: under the icon, in the stores, in the app's own words. */
  name: 'ShiftBoard',
  /** Invite links and QR codes: <scheme>://join?server=https://… (lowercase letters only). */
  scheme: 'shiftboard',
  /** Older invite links keep working after a rename: these schemes are still understood when pasted. */
  oldSchemes: ['shiftboard'],
  /** What the phone shows before the camera or photo library opens, in each language. {app} is the name above. */
  permissions: {
    en: {
      camera: '{app} uses the camera so you can add a picture to the 86 List, like the empty bottle or the shelf.',
      photos: '{app} opens your photos so you can add a picture to the 86 List, like the empty bottle or the shelf.',
    },
    es: {
      camera: '{app} usa la cámara para que agregues una foto a la Lista 86, como la botella vacía o el estante.',
      photos: '{app} abre tus fotos para que agregues una a la Lista 86, como la botella vacía o el estante.',
    },
  },
};
