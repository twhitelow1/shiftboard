// Adds what can't live in app.json. Everything else is in app.json.
//
// Android push (FCM v1) needs Firebase's google-services.json in the build. It isn't committed:
// on EAS it comes from the file environment variable GOOGLE_SERVICES_JSON (see
// docs/mobile-app/REGISTRATION-RUNBOOK.md, "Push credentials"); locally, put the file at
// mobile/google-services.json (git-ignored).
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'google-services.json');
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(local) ? './google-services.json' : undefined);
  return { ...config, android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) } };
};
