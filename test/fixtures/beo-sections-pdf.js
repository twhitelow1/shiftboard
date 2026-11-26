// One invented BEO laid out the way pdf.js reads a Tripleseat export, with every kind of section the BEO section
// model (core/beo-sections.js) carries: a run of show, a menu with dietary marks, a bar with a recipe, rentals, an
// unknown DECOR table, ENTERTAINMENT, a PHOTO BOOTH heading nobody knows, dietary counts, host and vendor contacts
// (with phone numbers and an email), setup and floor plan, special instructions, a course heading with nothing under
// it, and money everywhere that must never come through. Everyone and everything here is made up.
const CH = 0.5;
function pageItems(lines) {
  let y = 30;
  const out = [];
  for (const [gap, ...runs] of lines) {
    y += gap;
    for (const [x, str, o = {}] of runs) {
      const h = o.h || 12;
      out.push({ str, x, y: +(y + (o.dy || 0)).toFixed(1), w: +(str.length * h * CH).toFixed(1), h, bold: !!o.b, italic: !!o.i });
    }
  }
  return out;
}
const B = { b: true }, I = { i: true };
const QTY = [26, [42.8, 'Qty'], [475.7, 'Price'], [543.1, 'Total']];

/** options.guests / .stamp / .dietary / .decor / .noPhoto: the same BEO re-exported with changes. */
export function sectionsBeoItems({ guests = '80', stamp = '03/02/2027 10:00 am', dietary = '- Gluten free - 5 guests', decor = 'Ivory linens, floor length', noPhoto = false, invoice = '20000001' } = {}) {
  const pages = [[
    [9, [343.2, `INVOICE #: ${invoice}`]],
    [26, [386, `Updated: ${stamp} X`]],
    [16, [42, 'Marlowe Foundation Spring Gala', { b: true, h: 20 }], [381.2, 'Saturday, March 13, 2027', { h: 16, dy: 3.4 }]],
    [41, [42, 'BANQUET EVENT ORDER', B]],
    [28, [42, 'ACCOUNT:', B], [103.3, 'Marlowe Foundation'], [409.6, 'SALES MANAGER:', B], [512.9, 'Dana Example']],
    [23, [42, 'CONTACT:', B], [101.9, 'Robin Sample'], [427.8, 'EMAIL:', B], [469.6, 'dana@venue.example']],
    [23, [42, 'EMAIL: robin@marlowe.example', B], [469, 'EVENT MANAGER:', B], [560, 'Lee Planner']],
    [14.4, [42, 'BILL TO ADDRESS:', B], [150, '4 Invented Avenue']],
    [38.8, [42, 'PHONE:', B], [88.1, '555-010-8800']],
    [28, [42, 'EVENT SUMMARY', B]],
    [27, [434.4, 'Event'], [526, 'Event']],
    [7.2, [49.7, 'Date'], [104.8, 'Time'], [158.2, 'Location'], [304.6, 'Areas'], [472, 'Guests']],
    [7.2, [437.1, 'Type'], [518.5, 'F&B Min']],
    [18.9, [46, '3/13/', B], [90, '6:00 pm –', B], [163, 'Marlowe', B], [229, 'Grand Hall and Terrace', B], [410.4, 'Gala', B], [484, guests, { b: true, dy: 7 }], [513, '$9,000.00', { b: true, dy: 7 }]],
    [14.1, [48, '2027', B], [93, '11:00 pm', B], [168, 'House', B]],
    [34, [42, 'RENTAL', B]],
    QTY,
    [18.9, [42.8, '1'], [87, 'Arrival Notes for Host Team']],
    [14.4, [87, 'Load-in through the terrace gate from 2:00 pm']],
    [18.9, [42.8, '1'], [87, 'Grand Hall', B], [153, '- Private Event: 80 Guests'], [458.6, '$1,500.00'], [524.9, '$1,500.00']],
    [18.9, [87, 'Lounge furniture on the terrace', I]],
    [34, [42, 'FOOD', B]],
    QTY,
    [18.9, [42.8, '80'], [87, 'PLATED STYLE DINNER'], [458.6, '$110.00'], [515.4, '$8,800.00']],
    [14.4, [87, 'Serve Time: 7:00PM / Set: Grand Hall']],
    [18.9, [87, 'FIRST COURSE', B]],
    [18.9, [87, 'Spring Pea Soup (GF, V)']],
    [14.4, [87, 'mint, crème fraîche']],
    [18.9, [87, 'MAIN COURSE', B]],
    [18.9, [87, 'Halibut (GF, DF)']],
    [14.4, [87, 'spring onion, saffron broth']],
    [18.9, [87, 'LATE NIGHT SNACK TBD', B]],
  ], [
    [1.6, [42, 'BEVERAGE', B]],
    QTY,
    [18.9, [42.8, '1'], [87, 'Hosted Bar Package (Available: 6:00 pm – 11:00 pm)']],
    [14.4, [87, 'BAR: Grand Hall, Terrace']],
    [18.9, [87, 'Garden Spritz $13']],
    [28.8, [87, '1.5 oz gin']],
    [14.4, [87, 'Top with soda']],
    [14.4, [87, 'Collins Glass']],
    [34, [42, 'DECOR', B]],
    QTY,
    [18.9, [42.8, '80'], [87, decor], [465.5, '$4.00'], [524.9, '$320.00']],
    [18.9, [42.8, '10'], [87, 'Centerpieces: white peonies (Florist Example)'], [458.6, '$60.00'], [524.9, '$600.00']],
    [18.9, [42.8, '1'], [87, 'Linen delivery fee'], [465.5, '$75.00'], [524.9, '$75.00']],
    [34, [42, 'ENTERTAINMENT', B]],
    QTY,
    [18.9, [87, 'String quartet in the lobby, 6:00 – 7:00 pm']],
    [18.9, [87, 'DJ: Sample Beats, load-in 4:00 pm']],
    ...(noPhoto ? [] : [
      [34, [42, 'PHOTO BOOTH', B]],
      QTY,
      [18.9, [87, 'Booth on the terrace, props provided']],
    ]),
  ], [
    [1.6, [40.5, 'Dietary Restrictions and Counts:']],
    [14.4, [40.5, dietary]],
    [14.4, [40.5, '- Nut allergy - table 4']],
    [14.4, [40.5, '- Vegan - 2 guests']],
    [17.4, [45.8, 'Host/ Event Contact Details']],
    [31.6, [69.3, '•'], [84.3, 'Robin Sample 555-010-8800']],
    [34.6, [45.8, 'Vendor Contact Details']],
    [31.6, [69.3, '•'], [84.3, 'Florist: Florist Example, arrives 1:00 pm, 555-010-6001']],
    [14.4, [69.3, '•'], [84.3, 'Photographer: Lens Sample, lens@photo.example']],
    [34.6, [45.8, 'Setup Details']],
    [29.6, [40.5, 'Setup Details:', B]],
    [28.3, [65.5, '•'], [80.5, 'Rounds of 8, head table by the windows']],
    [27.8, [40.5, 'Floorplans:', B]],
    [28.2, [40.5, 'Stage at the north wall']],
    [30, [42.8, 'Date:', B], [106.9, 'Event Day', B]],
    [18.6, [42.8, '2:00PM'], [106.9, 'Vendor load-in']],
    [18.1, [42.8, '6:00PM'], [106.9, 'Guest Arrival']],
    [18.5, [42.8, '7:00PM'], [106.9, 'Dinner Service Begins', B]],
    [18.5, [42.8, '8:30PM'], [106.9, 'Toasts']],
    [18.5, [42.8, '10:30PM'], [106.9, 'Last call']],
    [18.5, [42.8, '11:00PM'], [106.9, 'End of Event']],
    [31.6, [238, 'SPECIAL INSTRUCTIONS', B]],
    [29.7, [40.5, 'Valet at the front door; coat check by the lobby']],
    [14.4, [40.5, 'Deposit of $2,000 paid with Visa ending in 4242']],
    [30, [543.1, 'Total']],
    [18.9, [42.8, 'Subtotal'], [508.5, '$10,795.00']],
    [18.9, [42.8, 'Gratuity 20.0%'], [508.5, '$2,159.00']],
    [30, [40.5, 'Client Signature', { b: true, h: 14 }]],
  ]];
  return pages.flatMap((lines, k) => [
    { page: k + 1, str: `Updated: ${stamp.split(' ')[0]}`, x: 489.3, y: 10.7, w: 60, h: 9, bold: false, italic: false },
    ...pageItems(lines).map((i) => ({ page: k + 1, ...i })),
    { page: k + 1, str: `${k + 1} of ${pages.length} Marlowe Foundation Spring Gala`, x: 230, y: 770.3, w: 150, h: 9, bold: false, italic: false },
  ]);
}
