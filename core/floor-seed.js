// SAMPLE floor plans for the demo build (web/src/api.js): the Patio and the Library drawn with the newer shapes
// (high-tops, booths, dividers, the kitchen door, restrooms), and the Restaurant's tables in three server sections.
// Invented; the demo never calls Toast or the AI. Kept out of core/seed.js so the tests' demo data stays as it was.
import { cleanPlan } from './floor-plan.js';

let n = 0;
const item = (type, x, y, w, h, label = '', seats = 0, extra = {}) => ({ id: `itm_demo_${++n}`, type, x, y, w, h, r: 0, label, seats, ...extra });

export function seedFloorDemo(store) {
  n = 0;
  const restaurant = store.get('rooms', 'room_restaurant');
  if (restaurant?.plan) {
    const zones = [
      { id: 'zone_demo_1', name: 'Section 1', color: '#2563eb' },
      { id: 'zone_demo_2', name: 'Section 2', color: '#16a34a' },
      { id: 'zone_demo_3', name: 'Section 3', color: '#d97706' },
    ];
    const zoneOf = (label) => (/^T[1-6]$/.test(label) ? 'zone_demo_1' : /^T[7-9]$/.test(label) ? 'zone_demo_2' : /^(B\d|T1[01])$/.test(label) ? 'zone_demo_3' : null);
    const items = restaurant.plan.items.map((i) => (zoneOf(i.label) ? { ...i, zone: zoneOf(i.label) } : i));
    items.push(item('restroom', 690, 620, 90, 60, 'Restrooms'), item('kitchen', 820, 640, 140, 50, 'Kitchen'));
    store.update('rooms', restaurant.id, { plan: cleanPlan({ ...restaurant.plan, zones, items }) });
  }

  const patio = store.get('rooms', 'room_patio');
  if (patio && !patio.plan?.items?.length) {
    const zones = [{ id: 'zone_demo_pa', name: 'Patio A', color: '#0891b2' }, { id: 'zone_demo_pb', name: 'Patio B', color: '#db2777' }];
    const items = [
      item('divider', 40, 30, 920, 8), item('divider', 40, 600, 640, 8),
      item('door', 880, 560, 60, 60, 'Entry'),
      ...[[90, 110], [250, 110], [410, 110], [90, 290], [250, 290], [410, 290]].map(([x, y], k) => item('table-round', x, y, 80, 80, `P${k + 1}`, 4, { zone: 'zone_demo_pa' })),
      ...[[620, 100], [760, 100], [620, 240], [760, 240]].map(([x, y], k) => item('table-hightop', x, y, 60, 60, `HT${k + 1}`, 2, { zone: 'zone_demo_pb' })),
      item('booth', 600, 400, 180, 80, 'PB1', 6, { zone: 'zone_demo_pb' }),
      item('table-rect', 90, 460, 180, 70, 'P7', 8, { zone: 'zone_demo_pa' }),
      item('plant', 50, 60, 40, 40), item('plant', 910, 60, 40, 40), item('plant', 520, 470, 40, 40),
      item('label', 330, 470, 160, 40, 'Garden'),
    ];
    store.update('rooms', patio.id, { plan: cleanPlan({ width: 1000, height: 650, zones, items }) });
  }

  const library = store.get('rooms', 'room_library');
  if (library && !library.plan?.items?.length) {
    const items = [
      item('wall', 0, 0, 1000, 10), item('wall', 0, 0, 10, 700),
      item('host', 40, 620, 90, 44, 'Host'), item('door', 150, 630, 60, 60, 'Entry'),
      ...[[120, 90], [420, 90], [720, 90], [120, 300], [420, 300], [720, 300]].map(([x, y], k) => item('table-rect', x, y, 180, 70, `L${k + 1}`, 8)),
      item('table-round', 140, 470, 120, 120, 'L7', 8), item('table-round', 440, 470, 120, 120, 'L8', 8),
      item('kitchen', 840, 640, 140, 50, 'Kitchen'), item('restroom', 700, 620, 90, 60, 'Restrooms'),
      item('label', 700, 500, 220, 40, 'The Library'),
    ];
    store.update('rooms', library.id, { plan: cleanPlan({ width: 1000, height: 700, items }) });
  }
}
