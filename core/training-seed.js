// Demo seed for Training: an invented menu (not a real restaurant's), two quizzes with a few tries by demo
// people so the leaderboard has data, the employee manual (with the call-out procedure) and who's on duty.
// Phone numbers are fictional (555-01xx). Photos are small SVG placeholders, not real photos.
import { createService } from './service.js';

const PHONES = { Moe: '(555) 010-0101', 'Chef Lucas': '(555) 010-0102', Kelly: '(555) 010-0103', Ben: '(555) 010-0104', CJ: '(555) 010-0105', Courtney: '(555) 010-0106', Tatiana: '(555) 010-0107' };
const CALL_OUT_LINE = '(555) 010-0100';

function prng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A plate (or a glass) drawn in the item's colors, so each item's "photo" looks different.
function placeholder(colors, drink, variant) {
  const [bg, a, b, c] = colors;
  const body = drink
    ? `<rect x="250" y="${120 + variant * 10}" width="140" height="200" rx="18" fill="#ffffff" fill-opacity=".35"/><rect x="258" y="${170 + variant * 10}" width="124" height="142" rx="12" fill="${a}"/><circle cx="360" cy="${150 + variant * 10}" r="26" fill="${b}"/><rect x="300" y="${80 + variant * 10}" width="8" height="120" fill="${c}"/>`
    : `<circle cx="320" cy="240" r="170" fill="#f8fafc"/><circle cx="320" cy="240" r="140" fill="#e2e8f0"/><ellipse cx="${290 + variant * 20}" cy="230" rx="78" ry="56" fill="${a}"/><circle cx="${370 - variant * 15}" cy="${200 + variant * 12}" r="38" fill="${b}"/><circle cx="300" cy="${290 - variant * 10}" r="24" fill="${c}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" width="640" height="480"><rect width="640" height="480" fill="${bg}"/>${body}<text x="620" y="462" text-anchor="end" font-family="sans-serif" font-size="18" fill="#ffffff" fill-opacity=".7">Sample photo</text></svg>`;
  return typeof Buffer !== 'undefined' ? Buffer.from(svg).toString('base64') : btoa(svg);
}

const ing = (rows) => rows.map(([qty, item]) => ({ qty, item }));

// [key, name, category, price, colors, drink?, en, es, allergens, dietary, extra]
const ITEMS = [
  ['shishito', 'Charred Shishito Peppers', 'Starters', 11, ['#14532d', '#65a30d', '#a3e635', '#facc15'], false, {
    description: 'Blistered shishito peppers with flaky salt, lime and a miso-honey glaze. About one in ten is spicy.',
    keyIngredients: ['shishito peppers', 'miso', 'honey', 'lime'],
    selling: { notes: 'Great to share while guests look at the menu. Say: “Most are mild, but every so often one has a kick.”', pairings: 'Garden Spritz, House Rosé' },
    recipe: { yield: '1 order', ingredients: ing([['6 oz', 'shishito peppers'], ['1 tbsp', 'neutral oil'], ['1 tbsp', 'miso-honey glaze'], ['pinch', 'flaky salt'], ['1 wedge', 'lime']]), steps: ['Heat the cast iron until it smokes.', 'Toss peppers in oil and char 2–3 minutes, turning once.', 'Off the heat, toss with the glaze.', 'Plate and finish with salt and the lime wedge.'] },
    prep: { notes: 'Glaze: 1 cup white miso, ½ cup honey, ¼ cup rice vinegar. Whisk; holds 7 days cold.' },
  }, {
    description: 'Pimientos shishito asados con sal en hojuelas, limón y glaseado de miso y miel. Más o menos uno de cada diez pica.',
    keyIngredients: ['pimientos shishito', 'miso', 'miel', 'limón'],
    selling: { notes: 'Ideal para compartir mientras ven el menú. Di: “Casi todos son suaves, pero de vez en cuando uno pica.”', pairings: 'Garden Spritz, Rosado de la casa' },
    recipe: { yield: '1 orden', ingredients: ing([['6 oz', 'pimientos shishito'], ['1 cda', 'aceite neutro'], ['1 cda', 'glaseado de miso y miel'], ['pizca', 'sal en hojuelas'], ['1 gajo', 'limón']]), steps: ['Calienta el sartén de hierro hasta que humee.', 'Mezcla los pimientos con aceite y ásalos 2–3 minutos, volteándolos una vez.', 'Fuera del fuego, mézclalos con el glaseado.', 'Emplata y termina con la sal y el gajo de limón.'] },
    prep: { notes: 'Glaseado: 1 taza de miso blanco, ½ taza de miel, ¼ taza de vinagre de arroz. Bate; dura 7 días en frío.' },
  }, ['soy'], ['vegetarian']],
  ['burrata', 'Burrata & Stone Fruit', 'Starters', 16, ['#7c2d12', '#fef3c7', '#fb923c', '#16a34a'], false, {
    description: 'Creamy burrata with grilled peaches, basil, toasted hazelnuts and aged balsamic. Served with grilled bread.',
    keyIngredients: ['burrata', 'peaches', 'basil', 'hazelnuts', 'balsamic', 'grilled bread'],
    selling: { notes: 'Seasonal. For gluten-free guests, leave off the bread and mark the ticket.', pairings: 'House Rosé' },
    recipe: { yield: '1 plate', ingredients: ing([['1 ball (4 oz)', 'burrata'], ['½', 'grilled peach'], ['4 leaves', 'basil'], ['1 tbsp', 'hazelnut crumble'], ['2 tsp', 'aged balsamic'], ['2 slices', 'grilled bread']]), steps: ['Grill peach eighths to order.', 'Set burrata in the center, peaches around it.', 'Top with hazelnuts, basil and balsamic.', 'Bread on the side.'] },
    prep: { notes: 'Toast hazelnuts at 350°F for 10 minutes, then rough chop. Burrata stays in its brine, cold, until plating.' },
  }, {
    name: 'Burrata con fruta de hueso',
    description: 'Burrata cremosa con duraznos asados, albahaca, avellanas tostadas y balsámico añejo. Se sirve con pan a la parrilla.',
    keyIngredients: ['burrata', 'duraznos', 'albahaca', 'avellanas', 'balsámico', 'pan a la parrilla'],
    selling: { notes: 'De temporada. Para clientes sin gluten, quita el pan y márcalo en la comanda.', pairings: 'Rosado de la casa' },
    prep: { notes: 'Tuesta las avellanas a 350°F por 10 minutos y pícalas grueso. La burrata se queda en su salmuera, en frío, hasta emplatar.' },
  }, ['milk', 'tree nuts', 'wheat'], ['vegetarian']],
  ['shrimp', 'Tempura Shrimp', 'Starters', 15, ['#1e3a8a', '#fdba74', '#f97316', '#fde68a'], false, {
    description: 'Crispy tempura shrimp with yuzu-chili mayo.',
    keyIngredients: ['shrimp', 'tempura batter', 'yuzu', 'chili mayo'],
    selling: { notes: '86’d until the new fryer is in. Suggest the Shishito Peppers instead.', pairings: '' },
    recipe: { yield: '1 order', ingredients: ing([['5', 'shrimp (16/20)'], ['1 cup', 'tempura batter'], ['2 tbsp', 'yuzu-chili mayo']]), steps: ['Dip shrimp in batter.', 'Fry at 360°F for 2 minutes.', 'Drain and serve with mayo.'] },
    prep: { notes: 'Make batter to order with ice-cold soda water.' },
  }, {
    name: 'Camarones tempura',
    description: 'Camarones tempura crujientes con mayonesa de yuzu y chile.',
    keyIngredients: ['camarones', 'masa tempura', 'yuzu', 'mayonesa de chile'],
    selling: { notes: 'Agotado hasta que llegue la freidora nueva. Sugiere los pimientos shishito.', pairings: '' },
  }, ['shellfish', 'wheat', 'eggs', 'soy'], [], { eightySixed: true }],
  ['chicken', 'Ember Roasted Half Chicken', 'Mains', 28, ['#78350f', '#d97706', '#fde047', '#15803d'], false, {
    description: 'Brined half chicken roasted over oak, with crispy potatoes and salsa verde.',
    keyIngredients: ['chicken', 'potatoes', 'salsa verde', 'parsley', 'garlic'],
    selling: { notes: 'Takes about 25 minutes: tell guests when they order. Our most-ordered main.', pairings: 'House Rosé' },
    recipe: { yield: '1 plate', ingredients: ing([['1', 'brined half chicken'], ['6 oz', 'crispy potatoes'], ['2 oz', 'salsa verde'], ['1 tbsp', 'butter']]), steps: ['Roast skin up at 450°F for 22 minutes.', 'Rest 3 minutes.', 'Crisp potatoes in butter.', 'Plate with salsa verde on the side.'] },
    prep: { notes: 'Brine 12–24 hours (5% salt). Par-roast potatoes at 400°F for 25 minutes. Salsa verde fresh each morning.' },
  }, {
    name: 'Medio pollo a las brasas',
    description: 'Medio pollo en salmuera asado con leña de roble, con papas crujientes y salsa verde.',
    keyIngredients: ['pollo', 'papas', 'salsa verde', 'perejil', 'ajo'],
    selling: { notes: 'Tarda unos 25 minutos: avísale al cliente al ordenar. Es el plato fuerte más pedido.', pairings: 'Rosado de la casa' },
  }, ['milk'], ['gluten-free']],
  ['salmon', 'Miso Glazed Salmon', 'Mains', 31, ['#0f172a', '#fb7185', '#f5f5f4', '#22c55e'], false, {
    description: 'Salmon with a sweet miso glaze over jasmine rice and charred bok choy, finished with sesame.',
    keyIngredients: ['salmon', 'miso', 'jasmine rice', 'bok choy', 'sesame seeds'],
    selling: { notes: 'Cooked medium unless the guest asks. We can leave off the sesame seeds, but the glaze has soy.', pairings: 'Garden Spritz' },
    recipe: { yield: '1 plate', ingredients: ing([['7 oz', 'salmon, skin on'], ['2 tbsp', 'miso glaze'], ['5 oz', 'jasmine rice'], ['1 head', 'baby bok choy'], ['1 tsp', 'toasted sesame seeds']]), steps: ['Sear skin side down 4 minutes.', 'Glaze and finish in the oven, 4 minutes.', 'Char bok choy on the plancha.', 'Rice, then bok choy, then salmon; sesame on top.'] },
    prep: { notes: 'Portion salmon at 7 oz, skin on. Rinse rice 3 times, cook at 1 : 1.2.' },
  }, {
    name: 'Salmón glaseado con miso',
    description: 'Salmón con glaseado dulce de miso sobre arroz jazmín y bok choy asado, terminado con ajonjolí.',
    keyIngredients: ['salmón', 'miso', 'arroz jazmín', 'bok choy', 'ajonjolí'],
    selling: { notes: 'Término medio salvo que el cliente pida otro. Podemos quitar el ajonjolí, pero el glaseado lleva soya.', pairings: 'Garden Spritz' },
  }, ['fish', 'soy', 'sesame', 'wheat'], ['dairy-free']],
  ['ragu', 'Mushroom Ragu Pappardelle', 'Mains', 24, ['#3f3f46', '#a16207', '#fef9c3', '#4d7c0f'], false, {
    description: 'Fresh pappardelle in a slow-cooked wild mushroom ragu with parmesan and thyme.',
    keyIngredients: ['pappardelle', 'wild mushrooms', 'parmesan', 'thyme', 'garlic'],
    selling: { notes: 'Our vegetarian favorite. Ask the kitchen before promising a vegan version.', pairings: 'House Rosé' },
    recipe: { yield: '1 plate', ingredients: ing([['6 oz', 'fresh pappardelle'], ['6 oz', 'mushroom ragu'], ['1 oz', 'parmesan'], ['1 tsp', 'thyme leaves']]), steps: ['Boil pasta 2 minutes.', 'Toss with hot ragu and a splash of pasta water.', 'Finish with parmesan and thyme.'] },
    prep: { notes: 'Ragu: sweat 2 lb mixed mushrooms with shallot and garlic, deglaze with white wine, simmer 45 minutes. Cut pasta sheets daily.' },
  }, {
    name: 'Pappardelle con ragú de hongos',
    description: 'Pappardelle fresca en ragú de hongos silvestres cocinado a fuego lento, con parmesano y tomillo.',
    keyIngredients: ['pappardelle', 'hongos silvestres', 'parmesano', 'tomillo', 'ajo'],
    selling: { notes: 'El favorito vegetariano. Pregunta en la cocina antes de prometer una versión vegana.', pairings: 'Rosado de la casa' },
  }, ['wheat', 'eggs', 'milk'], ['vegetarian']],
  ['burger', 'Smash Burger', 'Mains', 19, ['#450a0a', '#92400e', '#facc15', '#16a34a'], false, {
    description: 'Two smashed beef patties, cheddar, pickles and house sauce on a toasted sesame bun, with fries.',
    keyIngredients: ['beef', 'cheddar', 'pickles', 'house sauce', 'sesame bun', 'fries'],
    selling: { notes: 'Smashed patties come medium-well. Gluten-free bun available, but the fries share a fryer with breaded items.', pairings: '' },
    recipe: { yield: '1 burger', ingredients: ing([['2 × 3 oz', 'beef balls'], ['2 slices', 'cheddar'], ['4 chips', 'pickles'], ['1 oz', 'house sauce'], ['1', 'sesame bun']]), steps: ['Smash beef on a hot flat-top, season.', 'Flip after 2 minutes, add cheese.', 'Toast bun, sauce both sides.', 'Stack: patty, patty, pickles.'] },
    prep: { notes: 'Portion beef into 3 oz balls and keep cold. House sauce: mayo, ketchup, pickle brine, smoked paprika.' },
  }, {
    name: 'Smash Burger',
    description: 'Dos carnes de res aplastadas, queso cheddar, pepinillos y salsa de la casa en pan de ajonjolí tostado, con papas fritas.',
    keyIngredients: ['carne de res', 'cheddar', 'pepinillos', 'salsa de la casa', 'pan de ajonjolí', 'papas fritas'],
  }, ['wheat', 'milk', 'eggs', 'sesame', 'soy'], []],
  ['cake', 'Olive Oil Cake', 'Desserts', 10, ['#365314', '#fde68a', '#fffbeb', '#f97316'], false, {
    description: 'Moist olive oil cake with orange zest, whipped mascarpone and candied citrus.',
    keyIngredients: ['olive oil', 'orange', 'mascarpone', 'candied citrus'],
    selling: { notes: 'Not too sweet: a good pick for guests who “don’t do dessert”. Great with an espresso.', pairings: '' },
    recipe: { yield: '1 slice', ingredients: ing([['1/12', 'olive oil cake'], ['2 oz', 'whipped mascarpone'], ['3 pieces', 'candied citrus']]), steps: ['Slice cake into 12.', 'Quenelle of mascarpone on the side.', 'Candied citrus on top.'] },
    prep: { notes: 'Bake 2 cakes a day. Whip mascarpone with 10% sugar; holds 2 days.' },
  }, {
    name: 'Pastel de aceite de oliva',
    description: 'Pastel húmedo de aceite de oliva con ralladura de naranja, mascarpone batido y cítricos confitados.',
    keyIngredients: ['aceite de oliva', 'naranja', 'mascarpone', 'cítricos confitados'],
    selling: { notes: 'No es muy dulce: buena opción para quien “no come postre”. Va muy bien con un espresso.', pairings: '' },
  }, ['wheat', 'eggs', 'milk'], ['vegetarian']],
  ['potdecreme', 'Dark Chocolate Pot de Crème', 'Desserts', 11, ['#1c1917', '#451a03', '#fafaf9', '#d97706'], false, {
    description: 'Silky dark chocolate custard with sea salt, whipped cream and peanut brittle.',
    keyIngredients: ['dark chocolate', 'cream', 'sea salt', 'peanut brittle'],
    selling: { notes: 'Peanut brittle on top: always ask about nut allergies. We can leave the brittle off, but it’s made in a kitchen with nuts.', pairings: '' },
    recipe: { yield: '1 pot', ingredients: ing([['1', 'pot de crème'], ['1 oz', 'whipped cream'], ['1 piece', 'peanut brittle'], ['pinch', 'sea salt']]), steps: ['Pull from the walk-in 10 minutes before service.', 'Top with cream, salt and brittle.'] },
    prep: { notes: 'Bake in a water bath at 300°F for 35 minutes; chill at least 4 hours.' },
  }, {
    name: 'Pot de crème de chocolate amargo',
    description: 'Crema sedosa de chocolate amargo con sal de mar, crema batida y crocante de cacahuate.',
    keyIngredients: ['chocolate amargo', 'crema', 'sal de mar', 'crocante de cacahuate'],
    selling: { notes: 'Lleva crocante de cacahuate encima: siempre pregunta por alergias a nueces y cacahuate. Podemos quitarlo, pero se hace en una cocina con nueces.', pairings: '' },
  }, ['milk', 'eggs', 'peanuts'], ['vegetarian', 'gluten-free']],
  ['mule', 'Copper Fox Mule', 'Cocktails', 13, ['#7c2d12', '#fbbf24', '#bef264', '#e5e7eb'], true, {
    description: 'Vodka, fresh lime and spicy house ginger syrup, topped with soda. Served in a copper mug.',
    keyIngredients: ['vodka', 'lime', 'ginger', 'soda'],
    selling: { notes: 'Ask “Do you like it spicy?” and we can make it extra gingery. Swap in bourbon for a Kentucky version.', pairings: 'Smash Burger' },
    recipe: { yield: '1 drink', ingredients: ing([['2 oz', 'vodka'], ['0.75 oz', 'lime juice'], ['0.75 oz', 'ginger syrup'], ['2 oz', 'soda water']]), steps: ['Build in a copper mug over ice.', 'Top with soda and stir once.', 'Garnish with a lime wheel.'] },
    prep: { notes: 'Ginger syrup: juice 1 lb ginger, add the same weight of sugar; holds 5 days cold.' },
  }, {
    description: 'Vodka, limón fresco y jarabe picante de jengibre de la casa, con soda. Se sirve en taza de cobre.',
    keyIngredients: ['vodka', 'limón', 'jengibre', 'soda'],
    selling: { notes: 'Pregunta “¿Te gusta picante?” y lo hacemos con más jengibre. Con bourbon es la versión Kentucky.', pairings: 'Smash Burger' },
    recipe: { yield: '1 bebida', ingredients: ing([['2 oz', 'vodka'], ['0.75 oz', 'jugo de limón'], ['0.75 oz', 'jarabe de jengibre'], ['2 oz', 'agua mineral']]), steps: ['Arma la bebida en una taza de cobre con hielo.', 'Completa con soda y revuelve una vez.', 'Decora con una rueda de limón.'] },
    prep: { notes: 'Jarabe de jengibre: extrae el jugo de 1 lb de jengibre y agrega el mismo peso de azúcar; dura 5 días en frío.' },
  }, [], ['vegan', 'gluten-free']],
  ['spritz', 'Garden Spritz', 'Cocktails', 12, ['#064e3b', '#bbf7d0', '#fef08a', '#86efac'], true, {
    description: 'Gin, elderflower, cucumber and lemon topped with prosecco. Light and bubbly.',
    keyIngredients: ['gin', 'elderflower', 'cucumber', 'lemon', 'prosecco'],
    selling: { notes: 'Our lightest cocktail; great for brunch and the patio. For a low-proof version, skip the gin.', pairings: 'Charred Shishito Peppers' },
    recipe: { yield: '1 drink', ingredients: ing([['1 oz', 'gin'], ['0.5 oz', 'elderflower liqueur'], ['0.5 oz', 'lemon juice'], ['3 slices', 'cucumber'], ['3 oz', 'prosecco']]), steps: ['Shake gin, elderflower and lemon with ice.', 'Strain into a wine glass over fresh ice and cucumber.', 'Top with prosecco.'] },
    prep: { notes: 'Slice cucumbers thin and hold in cold water. An opened prosecco lasts 1 day with a stopper.' },
  }, {
    description: 'Ginebra, flor de saúco, pepino y limón, con prosecco. Ligero y burbujeante.',
    keyIngredients: ['ginebra', 'flor de saúco', 'pepino', 'limón', 'prosecco'],
    selling: { notes: 'Nuestro coctel más ligero; ideal para el brunch y el patio. Para una versión con menos alcohol, sin ginebra.', pairings: 'Pimientos shishito' },
    recipe: { yield: '1 bebida', ingredients: ing([['1 oz', 'ginebra'], ['0.5 oz', 'licor de flor de saúco'], ['0.5 oz', 'jugo de limón'], ['3 rodajas', 'pepino'], ['3 oz', 'prosecco']]), steps: ['Agita la ginebra, el licor y el limón con hielo.', 'Cuela en copa de vino con hielo nuevo y pepino.', 'Completa con prosecco.'] },
  }, [], ['vegan', 'gluten-free'], { visibility: { recipe: { departments: ['Bar', 'Moon Rabbit'] } } }],
  ['rose', 'House Rosé', 'Wine', 11, ['#831843', '#fda4af', '#fecdd3', '#fde68a'], true, {
    description: 'Dry, crisp rosé with strawberry and citrus notes. By the glass or the bottle.',
    keyIngredients: ['grenache', 'syrah'],
    selling: { notes: 'Say “dry and refreshing, not sweet.” It goes with almost every starter.', pairings: 'Charred Shishito Peppers, Burrata & Stone Fruit, Ember Roasted Half Chicken' },
    recipe: { yield: '6 oz pour', ingredients: [], steps: [] },
    prep: { notes: 'Keep 2 bottles in the ice well. Opened bottles last 3 days with a stopper.' },
  }, {
    name: 'Rosado de la casa',
    description: 'Rosado seco y fresco con notas de fresa y cítricos. Por copa o por botella.',
    selling: { notes: 'Di “seco y refrescante, no dulce.” Va con casi todas las entradas.', pairings: 'Pimientos shishito, burrata, medio pollo a las brasas' },
  }, ['sulfites'], ['vegan']],
];

const CUSTOM = [
  ['allergy', { kind: 'mc', text: 'A guest says they have a nut allergy. What do you do first?', choices: ['Tell the kitchen and mark the allergy on the ticket', 'Suggest the Pot de Crème', 'Tell them nothing here has nuts', 'Ask another server'], correct: 0,
    explain: 'Always tell the kitchen and mark it on the ticket, every time.',
    es: { text: 'Un cliente dice que es alérgico a las nueces. ¿Qué haces primero?', choices: ['Avisar a la cocina y marcar la alergia en la comanda', 'Sugerir el pot de crème', 'Decirle que aquí nada tiene nueces', 'Preguntarle a otro mesero'], explain: 'Siempre avisa a la cocina y márcalo en la comanda, todas las veces.' } }],
  ['86', { kind: 'tf', text: 'If a dish is 86’d, we’re out of it and can’t sell it.', correct: true, es: { text: 'Si un platillo está “86”, se acabó y no se puede vender.' } }],
  ['burratagf', { kind: 'tf', item: 'burrata', text: 'Burrata & Stone Fruit can be made gluten-free by leaving off the bread.', correct: true, explain: 'Leave off the bread and mark the ticket.',
    es: { text: 'La burrata se puede servir sin gluten si quitas el pan.', explain: 'Quita el pan y márcalo en la comanda.' } }],
  ['mulevodka', { kind: 'mc', item: 'mule', audience: 'recipe', text: 'How much vodka goes in a Copper Fox Mule?', choices: ['2 oz', '1 oz', '1.5 oz', '3 oz'], correct: 0,
    es: { text: '¿Cuánto vodka lleva un Copper Fox Mule?' } }],
];

const MANUAL = [
  ['welcome', 'Welcome', 'Bienvenida', [
    ['welcome', 'Welcome to the team', 'Bienvenido al equipo',
      '# Welcome!\nWe’re glad you’re here. This manual has the basics: how we work, what we expect, and what to do when something comes up.\n\n## Your first week\n- Shadow a trainer on at least **two shifts**.\n- Study the menu in **Training → Menu** and take the quizzes for your position.\n- Tap **I’ve read this** on each page of this manual.\n\nQuestions? Ask the manager on duty.',
      '# ¡Bienvenido!\nNos da gusto que estés aquí. Este manual tiene lo básico: cómo trabajamos, qué esperamos y qué hacer cuando pasa algo.\n\n## Tu primera semana\n- Acompaña a un entrenador en al menos **dos turnos**.\n- Estudia el menú en **Capacitación → Menú** y haz los cuestionarios de tu puesto.\n- Toca **Ya lo leí** en cada página de este manual.\n\n¿Dudas? Pregúntale al gerente en turno.'],
    ['uniform', 'Uniform & appearance', 'Uniforme e imagen',
      '# Uniform\n- **All black**: shirt, pants and non-slip shoes.\n- Hair tied back in the kitchen and behind the bar.\n- Name tag on every shift.\n\nEvents may have their own dress code. It’s on the BEO.',
      '# Uniforme\n- **Todo negro**: camisa, pantalón y zapatos antiderrapantes.\n- Cabello recogido en la cocina y en la barra.\n- Gafete en todos los turnos.\n\nLos eventos pueden tener su propio código de vestimenta. Está en el BEO.'],
  ]],
  ['policies', 'Policies', 'Políticas', [
    ['callout', 'Call-out procedure', 'Cómo avisar que no puedes ir',
      '# Can’t make your shift?\nCall out **as early as you can**: at least **4 hours** before your shift (8 hours for doubles and events).\n\n## How to call out\n1. **Call the manager on duty.** Use the **Call** button in ShiftBoard (My Shifts or Training). Texting a coworker doesn’t count.\n2. No answer? **Leave a voicemail and send a text** with your name, your shift and why.\n3. Still no answer after 15 minutes? Call the restaurant’s call-out line.\n4. Help find coverage: **give the shift away** or **trade it** in ShiftBoard. You’re still on the shift until a manager approves the change.\n\n## Good to know\n- Sick? Tell us. We never want you working sick around food.\n- A no-call, no-show is a serious policy violation.\n- Two late call-outs in 30 days means a talk with your manager.',
      '# ¿No puedes ir a tu turno?\nAvisa **lo antes posible**: al menos **4 horas** antes de tu turno (8 horas para turnos dobles y eventos).\n\n## Cómo avisar\n1. **Llama al gerente en turno.** Usa el botón **Llamar** en ShiftBoard (Mis turnos o Capacitación). Mandarle mensaje a un compañero no cuenta.\n2. ¿No contesta? **Deja un mensaje de voz y manda un texto** con tu nombre, tu turno y el motivo.\n3. ¿Sigue sin contestar después de 15 minutos? Llama a la línea para avisos del restaurante.\n4. Ayuda a cubrir el turno: **regálalo** o **cámbialo** en ShiftBoard. El turno sigue siendo tuyo hasta que un gerente apruebe el cambio.\n\n## Importante\n- ¿Estás enfermo? Avísanos. Nunca queremos que trabajes enfermo cerca de la comida.\n- No avisar y no presentarte es una falta grave.\n- Dos avisos tardíos en 30 días significan una plática con tu gerente.'],
    ['trades', 'Trading and picking up shifts', 'Cambiar y tomar turnos',
      '# Trades and pickups\nTrade, give away and pick up shifts in **Swaps & Trades**. A manager approves each change.\n\n- Trades need **12 hours’ notice**. Closer than that, call the manager on duty.\n- You can only pick up shifts for positions you’re trained in.',
      '# Cambios y turnos extra\nCambia, regala y toma turnos en **Cambios**. Un gerente aprueba cada cambio.\n\n- Los cambios necesitan **12 horas de anticipación**. Con menos tiempo, llama al gerente en turno.\n- Solo puedes tomar turnos de los puestos en los que estás capacitado.'],
    ['allergies', 'Food allergies', 'Alergias a alimentos',
      '# Food allergies\nAn allergy can be life or death. Every time a guest mentions one:\n1. **Tell the kitchen** and **mark the allergy on the ticket**.\n2. Check the item’s allergens in **Training → Menu**.\n3. Never guess. If you’re not sure, ask the chef.\n\nThe 9 major allergens: **milk, eggs, fish, shellfish, tree nuts, peanuts, wheat, soy and sesame**.',
      '# Alergias a alimentos\nUna alergia puede ser de vida o muerte. Cada vez que un cliente mencione una:\n1. **Avisa a la cocina** y **marca la alergia en la comanda**.\n2. Revisa los alérgenos del platillo en **Capacitación → Menú**.\n3. Nunca adivines. Si no estás seguro, pregúntale al chef.\n\nLos 9 alérgenos principales: **leche, huevo, pescado, mariscos, nueces de árbol, cacahuate, trigo, soya y ajonjolí**.'],
  ]],
];

/** Adds the Training demo data. `userId` and `jobId` are the main seed's maps (name → id, job key → id). */
export function seedTraining(store, { userId, jobId }) {
  const at = (d) => new Date(`${d}T15:00:00`).toISOString();
  for (const [name, phone] of Object.entries(PHONES)) if (userId[name]) store.update('users', userId[name], { phone });
  if (userId.Flor) store.update('users', userId.Flor, { language: 'es' }); // a Spanish speaker, to show the Spanish versions
  store.insert('trainingConfig', { id: 'main', leaderboard: 'all', callOutPhone: CALL_OUT_LINE });
  // The demo's clock is Sun Sep 27, 2026 (web/src/api.js); with no shifts that day, Kelly is set as manager on duty.
  store.insert('modOverrides', { id: '2026-09-27', date: '2026-09-27', userId: userId.Kelly, setBy: userId.Moe, at: at('2026-09-26') });

  // Menu
  const itemId = {};
  ITEMS.forEach(([k, name, category, price, colors, drink, en, es, allergens, dietary, extra = {}], i) => {
    const photos = [0, 1].slice(0, i % 3 === 2 ? 1 : 2).map((v) => {
      const data = placeholder(colors, drink, v);
      const photo = { id: `mph_${k}_${v + 1}`, w: 640, h: 480, bytes: Math.floor((data.length * 3) / 4) };
      store.insert('menuPhotos', { ...photo, itemId: `mnu_${k}`, mime: 'image/svg+xml', data, createdAt: at('2026-09-20') });
      return photo;
    });
    const blank = { yield: '', ingredients: [], steps: [] };
    itemId[k] = store.insert('menuItems', {
      id: `mnu_${k}`, name, category, price, order: i, allergens, dietary, eightySixed: false, visibility: {},
      ...en, selling: { pairings: '', ...en.selling }, recipe: { ...blank, ...en.recipe }, prep: { notes: '', ...en.prep },
      es: { name: '', description: '', keyIngredients: [], ...es, selling: { notes: '', pairings: '', ...es.selling }, recipe: { ...blank, ...es.recipe }, prep: { notes: '', ...es.prep } },
      photos, ...extra, createdAt: at('2026-09-20'), updatedAt: at('2026-09-20'),
    }).id;
  });

  // Managers' own questions
  const qid = {};
  for (const [k, q] of CUSTOM) {
    const { item, ...rest } = q;
    qid[k] = store.insert('quizQuestions', {
      id: `qq_${k}`, kind: rest.kind, text: rest.text, choices: rest.choices || [], correct: rest.correct, itemId: item ? itemId[item] : null, category: '',
      audience: rest.audience || 'all', explain: rest.explain || '', es: { text: '', choices: [], explain: '', ...rest.es }, createdAt: at('2026-09-20'), createdBy: userId.Moe,
    }).id;
  }

  // Quizzes
  const quiz = (id, doc) => store.insert('quizzes', {
    id, description: '', itemIds: [], questionIds: [], types: ['photo', 'allergen', 'ingredient', 'category', 'custom'], active: true,
    createdAt: at('2026-09-21'), createdBy: userId.Moe, updatedAt: at('2026-09-21'), ...doc,
  }).id;
  const basics = quiz('quz_basics', {
    title: 'Menu basics', es: { title: 'Lo básico del menú', description: 'Platillos, alérgenos y qué lleva cada uno. Para meseros, runners, garroteros y hosts.' },
    description: 'Dishes, allergens and what’s in them. For servers, runners, bussers and hosts.',
    categories: ['Starters', 'Mains', 'Desserts'], questionIds: [qid.allergy, qid['86']], count: 8, passingScore: 80,
    jobCodeIds: [jobId.SRV, jobId.FR, jobId.BUS, jobId.HOST], dueDate: '2026-10-09', feedback: 'each',
  });
  const bar = quiz('quz_bar', {
    title: 'Bar program', es: { title: 'El bar', description: 'Cocteles y vino: qué llevan y cómo venderlos.' },
    description: 'Cocktails and wine: what’s in them and how to sell them.',
    categories: ['Cocktails', 'Wine'], count: 6, passingScore: 70, jobCodeIds: [jobId.BAR, jobId.BBK, jobId.COC], dueDate: '2026-10-16', feedback: 'end',
  });

  // A few tries by demo people, answered at their "skill", so the leaderboard has something to show.
  let clock = new Date('2026-09-22T15:00:00');
  const rand = prng(2026);
  const svc = createService(store, { now: () => clock, random: rand });
  const TRIES = [
    ['Alex D', basics, 0.7], ['Alex D', basics, 0.97], ['Styves', basics, 0.6], ['Tori', basics, 0.85], ['Andrea', basics, 0.8],
    ['Jonathan', basics, 0.5], ['Flor', basics, 0.78], ['Miguel', basics, 0.65], ['Liz', basics, 0.92],
    ['Mak', bar, 0.75], ['Mak', bar, 0.95], ['Karen', bar, 0.8], ['Dante', bar, 0.68], ['Agustina', bar, 0.88], ['Hans', bar, 0.55],
  ];
  for (const [person, quizId, skill] of TRIES) {
    const actor = store.get('users', userId[person]);
    if (!actor) continue;
    clock = new Date(clock.getTime() + 5.5 * 3600 * 1000);
    const view = svc.call(actor, 'quiz.start', { quizId });
    const saved = store.get('quizAttempts', view.id);
    // About `skill` of the questions right, which ones at random.
    const right = new Set(saved.questions.map((q) => q.key).sort(() => rand() - 0.5).slice(0, Math.round(skill * saved.questions.length)));
    const answers = {};
    for (const q of saved.questions) {
      const wrong = q.choices.filter((c) => c.id !== q.correctId);
      answers[q.key] = right.has(q.key) || !wrong.length ? q.correctId : wrong[Math.floor(rand() * wrong.length)].id;
    }
    clock = new Date(clock.getTime() + 6 * 60 * 1000);
    svc.call(actor, 'quiz.submit', { attemptId: view.id, answers });
  }

  // Employee manual
  const pageId = {};
  MANUAL.forEach(([sk, title, titleEs, pages], si) => {
    const sectionId = store.insert('manualSections', { id: `msec_${sk}`, title, es: { title: titleEs }, order: si }).id;
    pages.forEach(([pk, pTitle, pTitleEs, body, bodyEs], pi) => {
      const v = pk === 'allergies' ? 2 : 1; // edited once, and everyone was asked to read it again
      pageId[pk] = store.insert('manualPages', {
        id: `mpg_${pk}`, sectionId, title: pTitle, body, es: { title: pTitleEs, body: bodyEs }, order: pi, isCallOut: pk === 'callout',
        version: v, ackVersion: v, updatedAt: at('2026-09-21'), updatedBy: userId.Moe,
      }).id;
    });
  });
  const ACKS = [
    ['welcome', ['Alex D', 'Styves', 'Tori', 'Andrea', 'Mak', 'Karen', 'Flor', 'Liz', 'Agustina'], 1],
    ['callout', ['Alex D', 'Tori', 'Mak', 'Liz', 'Flor'], 1],
    ['uniform', ['Alex D', 'Andrea'], 1],
    ['allergies', ['Alex D', 'Liz'], 2], ['allergies', ['Styves', 'Tori', 'Mak'], 1], // read the old version
  ];
  for (const [pk, people, version] of ACKS) {
    for (const person of people) {
      if (!userId[person]) continue;
      store.insert('manualAcks', { id: `${pageId[pk]}:${userId[person]}`, pageId: pageId[pk], userId: userId[person], version, at: at('2026-09-23') });
    }
  }
}
