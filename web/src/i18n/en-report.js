// "Report a problem" and the screen people see when something crashes, in English. Kept apart from en.js
// (which spreads them in) so the rest of the catalog stays easy to merge. es-report.js has the same keys.
export default {
  report: {
    menu: 'Report a problem',
    title: 'Report a problem',
    what: 'What happened?',
    whatPlaceholder: 'What were you trying to do, and what went wrong?',
    page: 'Which page? (optional)',
    pagePlaceholder: 'For example: Schedule, My Shifts, Trades',
    screenshot: 'Screenshot (optional)',
    addScreenshot: 'Add a screenshot',
    changeScreenshot: 'Change',
    pasteHint: 'or paste one here',
    removeScreenshot: 'Remove screenshot',
    screenshotAlt: 'Your screenshot',
    attached: 'We also attach the app version, this page, your device and the app’s last few steps. Never your passwords or what you typed elsewhere.',
    withError: 'The error on your screen is attached too.',
    send: 'Send',
    sending: 'Sending…',
    thanks: 'Thanks, we got it',
    thanksHelp: 'DubLow Digital reads every report. You can keep working.',
    needText: 'Tell us what happened',
    notImage: 'That file isn’t a picture we can use',
    failed: 'We couldn’t send it. Check your connection and try again.',
  },
  crash: {
    title: 'Something went wrong',
    body: 'This screen hit a problem. Reloading usually fixes it. You can also tell us what happened.',
    reload: 'Reload',
    report: 'Report this',
    sent: 'Thanks, we got it.',
  },
};
