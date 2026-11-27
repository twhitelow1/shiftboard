// Quick mode in the shift dialog (a person × day cell on the schedule): copy a time, move a shift, day off.
// es-quickshift.js has the same keys. Spread into en.js; scheduleLog's extra group is merged in there.
export default {
  quickShift: {
    fixedHelp: 'From the row you clicked. Only the time, tag and notes change here.',
    copyTime: 'Copy a time',
    theirWeek: 'Their other days this week',
    commonFor: 'Common for {position} this week',
    noTimesYet: 'No other times this week yet.',
    keyHint: 'Press 1–9 to pick',
    timesCount: '×{count}',
    timeIn: 'Time in',
    timeOut: 'Time out',
    moveShift: 'Move this shift',
    moveHelp: 'Change the date, person or position. This moves the shift (the same shift); it doesn’t add another.',
    changeAll: 'Change date, person or position',
    moving: 'Saving moves this shift: it’s the same shift, not a copy.',
    saveMove: 'Move shift',
    moved: 'Shift moved',
    dayOff: 'Day off',
    dayOffConfirm: { one: 'Tap again: remove {count} shift and mark day off', other: 'Tap again: remove {count} shifts and mark day off' },
    dayOffDone: '{name} is off {date}',
    isDayOff: '{name} is marked off this day (day off). You can still add a shift; it will show a warning.',
    undoDayOff: 'Undo day off',
    dayOffCleared: 'Day off removed',
    cell: 'DAY OFF',
    cellTitle: 'Marked off on purpose by a manager',
    addShift: 'Add shift',
    undo: 'Undo',
  },
};
export const scheduleLog = { g_dayOff: 'Days off' };
