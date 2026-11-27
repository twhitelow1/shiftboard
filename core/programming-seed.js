// SAMPLE regular programming for the demo (core/programming.js): invented, like the rest of the demo's samples.
//   Regular service   every day the restaurant is open, in the Restaurant, 11 AM to close
//   Immersive dinner  Wednesdays and Saturdays in Moon Rabbit, 6–9:30 PM, with pars (Cocktail servers in at 5)
//   DJ night          Fridays and Saturdays in the Rabbit Hole (the bar downstairs), 9 PM to 1 AM
//   Trivia night      the first Thursday of the month in the Rabbit Hole, 7–9 PM
// The demo week's Saturday wedding is a full buyout: it replaces the immersive dinner and part of the rest, and its
// own staffing lines are its pars. The Friday party in the Rabbit Hole replaces that night's DJ. The demo's
// shifts leave some pars short, so the coverage panel has gaps to show.
export function seedProgrammingDemo(store, { week, jobId }) {
  const at = `${week}T08:00:00.000Z`;
  const item = (id, order, doc) => store.insert('programming', {
    id, order, season: '', from: '', to: '', repeat: 'weekly', notes: '', dayNote: '', active: true, exceptions: {},
    createdAt: at, createdBy: null, updatedAt: at, updatedBy: null, ...doc,
  });
  item('prg_demo_regular', 0, {
    name: 'Regular service', rooms: ['Restaurant'], days: [0, 2, 3, 4, 5, 6], start: '11:00', end: '', color: '#2563eb', dayNote: 'Regular service',
    pars: [{ jobCodeId: jobId.SRV, count: 4, start: '16:00' }, { jobCodeId: jobId.BAR, count: 1 }, { jobCodeId: jobId.FR, count: 2, start: '16:30' },
      { jobCodeId: jobId.BUS, count: 1, start: '17:00' }, { jobCodeId: jobId.HOST, count: 1 }, { jobCodeId: jobId.MGR, count: 1 }],
  });
  item('prg_demo_immersive', 1, {
    name: 'Immersive dinner', rooms: ['Moon Rabbit'], days: [3, 6], start: '18:00', end: '21:30', color: '#9333ea',
    notes: 'Two seatings, 6:00 and 7:45. Phones away during the show.',
    pars: [{ jobCodeId: jobId.COC, count: 4, start: '17:00' }, { jobCodeId: jobId.BAR, count: 2, start: '17:00' }, { jobCodeId: jobId.HOST, count: 1, start: '17:30' }],
  });
  item('prg_demo_dj', 2, {
    name: 'DJ night', rooms: ['Rabbit Hole'], days: [5, 6], start: '21:00', end: '01:00', color: '#e11d48', notes: 'Cover at the door after 9.',
    pars: [{ jobCodeId: jobId.BAR, count: 3 }, { jobCodeId: jobId.BBK, count: 2, start: '20:00' }, { jobCodeId: jobId.DOOR, count: 2, start: '20:30' }],
  });
  item('prg_demo_trivia', 3, {
    name: 'Trivia night', rooms: ['Rabbit Hole'], days: [4], start: '19:00', end: '21:00', color: '#d97706', repeat: 'monthly', nth: 1,
    pars: [{ jobCodeId: jobId.BAR, count: 2 }, { jobCodeId: jobId.BBK, count: 1 }],
  });
}
