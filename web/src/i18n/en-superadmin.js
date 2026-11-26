// An Admin making themselves Super Admin (My settings → Become Super Admin) and the switch that allows it
// (Settings → Roles & features). es-superadmin.js has the same keys. Spread into en.js. The rules are in
// core/super-admin.js.
export default {
  superAdmin: {
    // My settings: the card (Admins only, while the restaurant allows it)
    cardTitle: 'Become Super Admin',
    cardHelp: 'You’re an Admin. Your restaurant lets Admins make themselves Super Admin, the role with full control.',
    effectTitle: 'What changes',
    effectControl: 'You can add, edit and remove Admins and other Super Admins.',
    effectSignedIn: 'You stay signed in. Nothing else about your account changes.',
    effectTold: 'Every other Admin and Super Admin is told, in the app and by email.',
    effectUndo: 'You can’t change it back yourself: only another Super Admin can.',
    start: 'Become Super Admin…',
    confirmTitle: 'Make yourself Super Admin?',
    confirmBody: 'Next you’ll confirm it’s you with your authenticator app or a passkey.',
    yesContinue: 'Yes, continue',
    verifyTitle: 'Confirm it’s you',
    verifyHelp: 'Type the 6-digit code from your authenticator app, or use a passkey.',
    code: 'Code from your authenticator app',
    usePasskey: 'Use a passkey',
    or: 'or',
    confirm: 'Become Super Admin',
    noPasskeyHere: 'Passkeys don’t work in this browser. Use your authenticator app.',
    doneTitle: 'You’re now a Super Admin',
    doneBody: 'The other Admins and Super Admins have been told. Team and Settings now show everything a Super Admin can do.',
    demoNote: 'This is a demo: it shows the steps, but nobody’s role changes. In your restaurant’s ShiftBoard it asks for your authenticator app or a passkey.',
    // Settings → Roles & features: the switch
    settingTitle: 'Admins can make themselves Super Admin',
    settingHelp: 'When it’s on, an Admin can make themselves Super Admin in My settings, after confirming it’s them with their authenticator app or a passkey. Every other Admin and Super Admin is told, in the app and by email.',
    settingOffHelp: 'Turn it off once your restaurant has the Super Admins it needs. After that, only a Super Admin (or DubLow Digital) can turn it back on.',
    superOnly: 'Only a Super Admin can change this.',
    on: 'On',
    off: 'Off',
    turnedOn: 'Admins can make themselves Super Admin',
    turnedOff: 'Admins can no longer make themselves Super Admin',
    notInSupport: 'DubLow Digital is signed in for support: this stays as it is.',
  },
};
