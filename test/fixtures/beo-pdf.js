// Invented BEOs laid out the way pdf.js reads a Tripleseat BEO export (web/src/pdf.js pdfToItems): three
// back to back in one "PDF". Everyone and everything here is made up.
//   1. Rivera Rehearsal Dinner: 3 pages, two EVENT SUMMARY rows (an earlier tasting and the dinner in bold),
//      family style, an add-on entrée, on-consumption bar, a timeline with an XX:XX placeholder.
//   2. Northside Robotics Holiday Party & Awards Night: 2 pages, the name and the long date each wrap to two
//      lines, plated, a cash bar with a recipe and a signature cocktail, an event type.
//   3. Okafor Lindqvist Wedding: 6 pages, a full buyout, passed apps and stations, A/V, dietary counts, host
//      and vendor contacts, a busy timeline, special instructions, and money everywhere (prices, fees, deposits,
//      card digits, a card number) that must never come through.
// Every page has the small "Updated:" stamp at the top and the "<n> of <m>  <name>" footer.
//
// options.newer: the same BEOs re-exported later (30 guests at 7:30 pm for the dinner, a later stamp).
// options.older: BEO 1 exported before the original. options.bold === false: no font information at all.

const CH = 0.5; // a character is about half its font size wide

/** [gap, ...runs]: a line `gap` points below the one before; a run is [x, text, { b, i, h, dy }]. */
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

function beo({ footer, stamp, pages }) {
  return pages.map((lines, k) => [
    { str: `Updated: ${stamp}`, x: 489.3, y: 10.7, w: 60, h: 9, bold: false, italic: false },
    ...pageItems(lines),
    { str: `${k + 1} of ${pages.length} ${footer}`, x: 230, y: 770.3, w: 150, h: 9, bold: false, italic: false },
  ]);
}

/** The EVENT SUMMARY header: "Event / Type" and "Event / F&B Min" stacked over their columns. */
const SUMMARY_HEAD = [
  [27, [434.4, 'Event'], [526, 'Event']],
  [7.2, [49.7, 'Date'], [104.8, 'Time'], [158.2, 'Location'], [304.6, 'Areas'], [472, 'Guests']],
  [7.2, [437.1, 'Type'], [518.5, 'F&B Min']],
];
const QTY_HEAD = [26, [42.8, 'Qty'], [475.7, 'Price'], [543.1, 'Total']];
const TOTALS = (rows) => [[30, [543.1, 'Total']], ...rows.map(([label, amount, o]) => [18.9, [42.8, label, o], [508.5, amount, o]]), [30, [40.5, 'Client Signature', { b: true, h: 14 }]]];

export function beoItems({ newer = false, older = false, bold = true } = {}) {
  const dinner = newer ? { start: '7:30 pm –', guests: '30', stamp: '12/01/2026 9:10 am' } : { start: '7:00 pm –', guests: '24', stamp: older ? '11/20/2026 8:00 am' : '11/28/2026 2:15 pm' };

  const rivera = beo({
    footer: 'Rivera Rehearsal Dinner', stamp: dinner.stamp.split(' ')[0],
    pages: [[
      [9, [343.2, 'INVOICE #: 10000001']],
      [26, [386, `Updated: ${dinner.stamp} X`]],
      [16, [42, 'Rivera Rehearsal Dinner', { b: true, h: 20 }], [381.2, 'Friday, December 4, 2026', { h: 16, dy: 3.4 }]],
      [41, [42, 'BANQUET EVENT ORDER', B]],
      [28, [42, 'ACCOUNT:', B], [103.3, 'Jordan Rivera'], [409.6, 'SALES MANAGER:', B], [512.9, 'Pat Example']],
      [23, [42, 'CONTACT:', B], [101.9, 'Jordan Rivera'], [427.8, 'EMAIL:', B], [469.6, 'pat@copperfox.example']],
      [23, [42, 'EMAIL: jordan.rivera@example.com', B], [469, 'EVENT MANAGER:', B], [560, 'Sam Planner']],
      [23, [335.4, 'Remit Address:', { b: true, h: 9 }], [399.3, '1 Sample Street, Townsville', { h: 9 }]],
      [14.4, [42, 'BILL TO ADDRESS:', B], [150, '12 Example Lane']],
      [38.8, [42, 'PHONE:', B], [88.1, '555-010-2000']],
      [28, [42, 'EVENT SUMMARY', B]],
      ...SUMMARY_HEAD,
      [18.9, [46, '9/10/'], [90, '6:00 pm –'], [163, 'Copper'], [250, 'Main Dining Large Party'], [487, '4', { dy: 7 }]],
      [14.1, [48, '2026'], [96, '8:00 pm'], [168, 'Fox']],
      [18.9, [46, '12/4/', B], [90, dinner.start, B], [163, 'Copper', B], [229, 'Main Dining and Garden Room', B], [484, dinner.guests, { b: true, dy: 7 }], [513, '$1,800.00', { b: true, dy: 7 }]],
      [14.1, [48, '2026', B], [93, '10:00 pm', B], [168, 'Fox', B]],
      [34, [42, 'RENTAL', B]],
      QTY_HEAD,
      [18.9, [42.8, '1'], [87, 'Arrival Notes for Host Team']],
      [14.4, [87, 'Side door entrance / Hand out welcome cards']],
      [18.9, [42.8, '1'], [87, 'Garden Room', B], [153, '- Private Room: 24 Guests'], [458.6, '$500.00'], [524.9, '$500.00']],
      [18.9, [87, 'Food and Beverage Minimum - $1800.00', B], [449, '$1,800.00']],
      [34, [42, 'FOOD', B]],
      QTY_HEAD,
      [18.9, [42.8, '24'], [87, 'FAMILY STYLE DINNER'], [458.6, '$95.00'], [515.4, '$2,280.00']],
      [14.4, [87, 'Serve Time:'], [150.7, '7:30 pm', { h: 10.5, dy: 1.5 }], [190.1, '/ Set: ROOM']],
      [14.4, [87, '*Choice of (2) starters, (2) mains and (1) dessert for', I]],
      [14.4, [87, 'each table', I]],
      [28.8, [87, 'Menu Heading: XXX']],
      [18.9, [87, 'FIRST COURSE', B]],
      [18.9, [87, 'HEIRLOOM BEET SALAD']],
      [14.4, [87, 'whipped feta, blood orange, toasted pistachio, honey and white balsamic']],
      [14.4, [87, 'vinaigrette']],
    ], [
      [1.6, [87, 'Charred Carrots (GF, V)']],
      [18.9, [87, 'MAIN COURSE', B]],
      [18.9, [87, 'BRAISED SHORT RIB']],
      [14.4, [87, 'creamy polenta, gremolata, red wine jus']],
      [18.9, [42.8, '24'], [87, '(Additional Entree Selection)', I], [465.5, '$12.00'], [524.9, '$288.00']],
      [14.4, [87, 'SEARED SALMON']],
      [14.4, [87, 'lemon beurre blanc, shaved fennel']],
      [18.9, [87, 'DESSERT COURSE', B]],
      [18.9, [87, 'Chocolate Torte (Contains Nuts)']],
      [33, [42, 'BEVERAGE', B]],
      QTY_HEAD,
      [18.9, [42.8, '1'], [87, 'On-Consumption Tab (Available:'], [258.4, '7:00 pm – 10:00 pm', { h: 10.5, dy: 1.5 }], [343, ')']],
      [14.4, [87, 'Host covers guest drinks / Full drink menu available', I]],
      [37.6, [40.5, 'Dietary Restrictions:', B]],
      [14.8, [65.5, '•']],
      [30.8, [45.8, 'Contact Information - Host and Vendor Contact Details']],
      [18.2, [44.3, 'On-Site Contact: Jordan Rivera 555-010-2000']],
      [41.1, [45.8, 'Setup Notes']],
      [18.1, [44.3, 'Setup Details:']],
      [18.2, [44.3, 'Long family tables, candles only']],
      [35.3, [40.5, 'Floorplans:', B]],
      [28.2, [40.5, 'Two tables of twelve']],
    ], [
      [1.6, [42.8, 'Date:', B], [106.9, 'Event Day', B]],
      [18.6, [42.8, '6:30PM'], [106.9, 'Venue Open for Setup']],
      [18.1, [42.8, '7:00PM'], [106.9, 'Guest Arrival']],
      [18.2, [106.9, 'Bar Opens', B], [165.1, '(HOURS: 7:00 pm – 10:00 pm)']],
      [18.5, [42.8, 'XX:XX'], [106.9, 'Toasts']],
      [18.5, [42.8, '7:30PM'], [106.9, 'Food Service Begins', B]],
      [18.5, [42.8, '10:00PM'], [106.9, 'End of Event']],
      [18.1, [42.8, '10:30PM'], [106.9, 'Venue Available for Clean Up -'], [267.8, 'Additional Timing Needed may result in additional charges', I]],
      ...TOTALS([
        ['Food', '$2,568.00'], ['Subtotal', '$2,568.00'], ['Tax Rate 9.4%', '$241.39'], ['Gratuity 20.0%', '$513.60'], ['Grand Total', '$3,322.99'],
        ['Non-Refundable 50% Deposit (Credit Card 4242 Visa) Paid 11/1/2026', '-$1,661.50'], ['Estimated Amount Due', '$1,661.49', B], ['F&B Minimum $1,800.00 Total', '$0.00'],
      ]),
    ]],
  });

  const northside = beo({
    footer: 'Northside Robotics Holiday Party & Awards Night', stamp: newer ? '12/01/2026' : '11/29/2026',
    pages: [[
      [9, [360.9, 'INVOICE #: 10000002']],
      [26, [392.4, `Updated: ${newer ? '12/01/2026 9:12 am' : '11/29/2026 9:05 am'} X`]],
      [16, [42, 'Northside Robotics Holiday Party &', { b: true, h: 20 }], [400.6, 'Saturday, December 5,', { h: 16, dy: 5.5 }]],
      [23.4, [42, 'Awards Night', { b: true, h: 20 }], [532.9, '2026', { h: 16, dy: 4 }]],
      [41, [42, 'BANQUET EVENT ORDER', B]],
      [25, [42, 'ACCOUNT:', B], [103.3, 'Northside Robotics'], [409.4, 'SALES MANAGER:', B], [512.7, 'Pat Example']],
      [17.8, [42, 'CONTACT:', B], [101.9, 'Alex Sample'], [427.6, 'EMAIL:', B], [469.4, 'pat@copperfox.example']],
      [17.7, [42, 'EMAIL:', B], [83.1, 'alex@northside.example'], [469, 'EVENT MANAGER:', B]],
      [32, [42, 'BILL TO ADDRESS:', B], [146.9, '9 Sample Road'], [335.2, 'Remit Address:', { b: true, h: 9 }]],
      [19.1, [42, 'PHONE:', B], [88.1, '(555) 010-3000']],
      [25.2, [42, 'EVENT SUMMARY', B]],
      ...SUMMARY_HEAD,
      [18.9, [46, '12/5/', B], [90, '6:00 pm –', B], [163, 'Copper', B], [289, 'Cellar Bar', B], [410.4, 'Holiday', B], [484, '60', { b: true, dy: 7 }], [513, '$4,000.00', { b: true, dy: 7 }]],
      [14.1, [48, '2026', B], [93, '11:00 pm', B], [168, 'Fox', B], [414, 'Party', B]],
      [34, [42, 'FOOD', B]],
      QTY_HEAD,
      [18.9, [87, 'PLATED STYLE DINNER']],
      [14.4, [87, 'Serve Time: 7:00PM / Set: Cellar Bar']],
      [28.8, [87, 'Menu Heading: XXX']],
      [18.9, [87, 'Course 1']],
      [14.4, [87, '“Winter Greens”']],
      [14.4, [87, 'Pear, Candied Walnut, Blue Cheese']],
      [28.8, [87, 'Course 2']],
      [14.4, [87, 'Roast Chicken']],
      [14.4, [87, 'Root Vegetables, Thyme Jus']],
    ], [
      [1.6, [42, 'BEVERAGE', B]],
      QTY_HEAD,
      [18.9, [87, 'Cash Bar']],
      [14.4, [87, 'Guests buy their own drinks / Full bar menu available', I]],
      [18.9, [87, 'Snowfall Spritz $14']],
      [28.8, [87, '1.5 oz gin']],
      [14.4, [87, '.5 oz elderflower liqueur']],
      [14.4, [87, 'Top with prosecco']],
      [14.4, [87, 'Coupe Glass']],
      [14.4, [87, 'gin, elderflower, prosecco']],
      [28.8, [87, 'Signature Cocktail #2', B]],
      [37.6, [40.5, 'Dietary Restrictions:', B]],
      [14.8, [65.5, '•'], [80.5, 'Vegetarian - 4 guests']],
      [14.4, [65.5, '•'], [80.5, 'Shellfish allergy - 1 guest']],
      [30, [42.8, 'Date:', B], [106.9, 'Event Day', B]],
      [18.6, [42.8, '5:30PM'], [106.9, 'Venue Open for Setup']],
      [18.1, [42.8, '6:00 PM'], [106.9, 'Guest Arrival']],
      [18.2, [42.8, 'XX:XX'], [106.9, 'Bar Opens', B], [165.1, '(HOURS: XX:XX - XX:XX)']],
      [18.5, [42.8, '7:00PM'], [106.9, 'Dinner Service Begins', B]],
      [18.5, [42.8, '9:00'], [106.9, 'Awards']],
      [18.5, [42.8, '11:00 PM'], [106.9, 'End of Event']],
      [31.6, [238, 'SPECIAL INSTRUCTIONS', B]],
      [29.7, [40.5, 'Projector needed for the awards slideshow']],
      [27.8, [40.5, 'Pay the balance with CC on file at the end of the night']],
      ...TOTALS([['Subtotal', '$0.00'], ['Deposit (Credit Card 1111 Mastercard) Paid 10/2/2026', '-$2,000.00'], ['Estimated Amount Due', '$0.00', B]]),
    ]],
  });

  const okafor = beo({
    footer: 'Okafor Lindqvist Wedding', stamp: newer ? '12/01/2026' : '11/20/2026',
    pages: [[
      [9, [380, 'INVOICE #: 10000003']],
      [26, [392.4, `Updated: ${newer ? '12/01/2026 9:20 am' : '11/20/2026 4:40 pm'} X`]],
      [16, [42, 'Okafor Lindqvist Wedding', { b: true, h: 20 }], [395, 'Sunday, December 6, 2026', { h: 16, dy: 3.4 }]],
      [41, [42, 'BANQUET EVENT ORDER', B]],
      [25, [42, 'ACCOUNT:', B], [103.3, 'Okafor / Lindqvist Wedding'], [409.4, 'SALES MANAGER:', B], [512.7, 'Pat Example']],
      [17.8, [42, 'CONTACT:', B], [101.9, 'Riley Okafor'], [427.6, 'EMAIL:', B], [469.4, 'pat@copperfox.example']],
      [17.7, [42, 'EMAIL:', B], [83.1, 'riley@example.org']],
      [32, [42, 'BILL TO ADDRESS:', B]],
      [19.1, [42, 'PHONE:', B], [88.1, '555-010-4000']],
      [25.2, [42, 'EVENT SUMMARY', B]],
      ...SUMMARY_HEAD,
      [18.9, [46, '12/6/', B], [90, '4:00 pm –', B], [163, 'Copper', B], [244, 'Copper Fox Full', B], [481, '120', { b: true, dy: 7 }], [507, '$15,000.00', { b: true, dy: 7 }]],
      [14.1, [48, '2026', B], [96, '10:00 pm', B], [168, 'Fox', B], [268, 'Buyout', B]],
      [34, [42, 'RENTAL', B]],
      [26, [463.5, 'Discount']],
      [7.2, [42.8, 'Qty'], [373.6, 'Price Discount'], [543.1, 'Total']],
      [7.2, [483.8, 'Price']],
      [18.9, [42.8, '1'], [75.8, 'Arrival Notes for Host Team']],
      [14.4, [75.8, 'Guests arrive by shuttle at the front door']],
      [18.9, [42.8, '1'], [75.8, 'Copper Fox FULL Venue Buyout -', B], [340, '$8,000.00'], [429.3, '25% $6,000.00 $6,000.00']],
      [14.8, [75.8, 'Discounted', B]],
      [14.8, [75.8, 'Includes: All rooms, house tables and chairs', I]],
      [14.4, [75.8, '*waived rental fee once the food and beverage minimum', I]],
      [14.4, [75.8, 'is met', I]],
    ], [
      [1.6, [42, 'FOOD', B]],
      QTY_HEAD,
      [18.9, [87, 'PASSED APPETIZERS', B]],
      [14.8, [87, 'Serve Time: 4:00 - 5:00PM / Room: Garden Room']],
      [18.9, [42.8, '120'], [87, 'Tuna Crudo (GF, DF)'], [472.5, '$7.00'], [524.9, '$840.00']],
      [18.9, [42.8, '120'], [87, 'Mushroom Toast (V)'], [472.5, '$6.00'], [524.9, '$720.00']],
      [18.9, [87, 'Grazing Stations']],
      [14.4, [87, 'Serve Time: 5:00 - 7:00PM / Location: Main Dining,']],
      [14.4, [87, '& Cellar Bar']],
      [18.9, [42.8, '120'], [87, 'Chef Attended Station: Herb Roast Beef Carving'], [465.5, '$40.00'], [515.4, '$4,800.00']],
      [14.4, [87, 'Set by: 5:00pm – 7:00pm / Room: Main Dining']],
      [14.4, [87, 'Must be purchased with a full buffet ($200 / per Chef, per 90', I]],
      [14.4, [87, 'min)', I]],
      [14.4, [87, 'Includes: horseradish cream, soft rolls']],
      [28.8, [87, '2 carving stations', B]],
      [19.3, [42.8, '120'], [87, 'Roasted Squash (V)'], [289.7, 'Served with the', B], [472.5, '$6.00'], [524.9, '$720.00']],
      [14.8, [87, 'Carving Station', B]],
      [18.9, [42.8, '110'], [87, 'DESSERT DISPLAY'], [465.5, '$18.00'], [515.4, '$1,980.00']],
      [14.4, [87, 'Serve Time: 8:00 - 9:30PM / Room: Cellar Bar']],
      [18.9, [87, 'Lemon Tart (V)']],
      [18.9, [87, 'Hazelnut Bar (Contains Nuts)']],
    ], [
      [1.6, [42.8, '4'], [87, 'Vendor Meal', B], [465.5, '$50.00'], [524.9, '$200.00']],
      [14.4, [87, 'Service Time: 6:00pm']],
      [28.8, [87, 'DJ, photographer, planner']],
      [33, [42, 'BEVERAGE', B]],
      QTY_HEAD,
      [18.9, [87, 'Passed -']],
      [15.4, [87, 'Serve Time: 4:00 - 4:30PM', { h: 11 }]],
      [28.8, [87, 'Sparkling wine on arrival', { h: 11 }]],
      [28.8, [87, 'Open Package Service Fee (Specialty Cocktails Only)', { i: true, h: 11 }]],
      [17.9, [42.8, '120'], [87, 'Signature Cocktail #1 -', B], [213.9, 'Fox Old Fashioned'], [472.5, '$2.00'], [524.9, '$240.00']],
      [19.3, [87, 'Premium Package Open Bar (Available: 4:00 - 10:00)']],
      [14.4, [87, '($18 / Per Hour / Per Guest)']],
      [14.4, [87, 'BAR: Main Dining, Cellar Bar']],
      [18.9, [42.8, '120'], [87, '1st Hour - Premium Package 4:00'], [465.5, '$18.00'], [515.4, '$2,160.00']],
      [18.9, [42.8, '120'], [87, '2nd Hour - Premium Package 5:00'], [465.5, '$18.00'], [515.4, '$2,160.00']],
    ], [
      [1.6, [42, 'AV SUPPORT NEEDS', B]],
      QTY_HEAD,
      [18.9, [87, 'DJ Information: DJ Example', B]],
      [14.7, [87, 'Set Time: 6:00-10:00PM']],
      [18.9, [42.8, '1'], [87, 'Sound Co Invoice -', B], [458.6, '$400.00'], [524.9, '$400.00']],
      [18.9, [87, 'Microphone for toasts']],
      [31.6, [40.5, 'Dietary Restrictions and Counts:']],
      [14.4, [40.5, '- Gluten Free - 6 People']],
      [14.4, [40.5, '- Nut allergy - 2 people']],
      [17.4, [45.8, 'Host/ Event Contact Details']],
      [31.6, [69.3, '•'], [84.3, 'Riley Okafor & Sam Lindqvist']],
      [14.4, [69.3, '•'], [84.3, '555 - 010 - 4001']],
      [34.6, [45.8, 'Vendor Contact Details']],
      [31.6, [69.3, '•'], [84.3, 'Florist: Petal Example 555-010-5000']],
      [34.6, [45.8, 'Setup Details']],
      [29.6, [40.5, 'Setup Details:', B]],
      [28.3, [65.5, '•'], [80.5, 'Garden Room']],
      [14.4, [108.2, '◦'], [120.5, 'lounge seating, remove two tables']],
      [14.4, [65.5, '•']],
      [27.8, [40.5, 'Floorplans:', B]],
    ], [
      [1.6, [42.8, 'Date:', B], [106.9, 'Event Day', B]],
      [19.6, [42.8, '1:00PM'], [106.9, 'Venue Open for Setup']],
      [19.4, [42.8, '4:00PM'], [106.9, 'Guest Arrival']],
      [19.3, [106.9, 'Bar Opens', B], [165.1, '(HOURS: 4:00 - 10:00)']],
      [23.2, [106.9, 'Passed Beverages & Apps Upon Arrival:']],
      [20.7, [42.8, '4:00PM -']],
      [7.2, [132, '•'], [146.9, 'Apps']],
      [7.2, [42.8, '5:00PM']],
      [7.2, [132, '•'], [146.9, 'Sparkling wine']],
      [35.8, [42.8, '5:00PM']],
      [7.1, [106.9, 'Dinner Service Begins', B]],
      [7.3, [42.8, '-7:00PM']],
      [18.2, [42.8, '7:20'], [106.9, 'First Dance']],
      [21.9, [42.8, '8:00PM'], [106.9, 'Cake Cutting', B]],
      [19.6, [42.8, '10:00PM'], [106.9, 'End of Event']],
      [19.4, [42.8, '60'], [106.9, 'Venue Available for Clean Up -'], [267.8, 'Additional Timing Needed may result in additional charges', I]],
      [32.3, [238, 'SPECIAL INSTRUCTIONS', B]],
      [23.7, [40.5, 'Couple arrives at 4:45 for photos in the garden']],
      [14.4, [40.5, 'Card on file 4242 4242 4242 4242 for any overages']],
      [14.4, [40.5, 'Shuttle drop-off at the front door every 20 minutes']],
    ], [
      ...TOTALS([
        ['Food', '$9,060.00'], ['Subtotal', '$15,000.00'], ['Gratuity 18.0%', '$2,700.00'], ['Admin Fee 4.0%', '$600.00'], ['Grand Total', '$19,710.00'],
        ['Deposit (Credit Card 4242 Visa) Paid 6/1/2026', '-$5,000.00'], ['Additional Deposit (Credit Card 9876 Amex) Paid 9/1/2026', '-$5,000.00'],
        ['Estimated Amount Due', '$9,710.00', B], ['F&B Minimum $15,000.00 Total', '$0.00'],
      ]),
    ]],
  });

  const pages = [...rivera, ...northside, ...okafor];
  return pages.flatMap((items, k) => items.map((i) => ({ page: k + 1, ...i, ...(bold ? {} : { bold: false, italic: false }) })));
}
