// A menu written as labeled blocks (Name / Menu Price: / Description: / Allergens: / Friendliness:) with section
// headings between dishes: core/smart-import.js menuFromLabeledText, used by menuFromText. Invented dishes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuFromText, normalizeMenuItem } from '../core/smart-import.js';

const DOC = `Small Plates
Crispy Polenta Bites
Menu Price: $14.00
Description:
Polenta squares fried crisp, with a smoked tomato jam.
Allergens: Milk, Egg, Wheat
Friendliness: Vegetarian, GF Possible
Roasted Beet Salad
Menu Price: $16.00
Description:
Roasted beets, citrus, pistachio and whipped feta.
More text that wraps onto a second line.
Allergens: Milk, treenuts (pistachio)
Friendliness: Vegetarian, Gluten Free
Large Plates
Grilled Trout
Menu Price: $32.00
Description: Whole trout with brown butter and capers.
Allergens: Fish, Milk, Soybean (in the glaze)
Friendliness: Pescatarian, DF Possible
Chef's Surprise
Description: Ask your server.
Allergens: N/A
Friendliness: N/A`;

test('labeled menu blocks: dishes, sections, prices, descriptions, allergens and dietary tags', () => {
  const rows = menuFromText(DOC);
  const items = rows.map((r) => normalizeMenuItem(r.values).data);
  assert.deepEqual(items.map((x) => x.name), ['Crispy Polenta Bites', 'Roasted Beet Salad', 'Grilled Trout', "Chef's Surprise"]);
  assert.deepEqual(items.map((x) => x.category), ['Small Plates', 'Small Plates', 'Large Plates', 'Large Plates']);
  assert.deepEqual(items.map((x) => x.price ?? null), [14, 16, 32, null], 'no price line: no price');
  assert.match(items[1].description, /pistachio and whipped feta\. More text that wraps/, 'a description on the lines below its label, wrapped');
  assert.equal(items[2].description, 'Whole trout with brown butter and capers.');
  assert.deepEqual(items[0].allergens.sort(), ['eggs', 'milk', 'wheat'].sort());
  assert.ok(items[1].allergens.includes('tree nuts'), 'treenuts → tree nuts');
  assert.ok(items[2].allergens.includes('soy') && items[2].allergens.includes('fish'), 'Soybean → soy');
  assert.deepEqual(items[3].allergens, [], 'N/A means none');
  assert.deepEqual(items[0].dietary, ['vegetarian'], '"GF Possible" is not a gluten-free tag');
  assert.match(items[0].sellingNotes, /Can be made: gluten-free/);
  assert.deepEqual(items[1].dietary.sort(), ['gluten-free', 'vegetarian']);
  assert.match(items[1].sellingNotes, /Allergen notes: pistachio/);
  assert.match(items[2].sellingNotes, /Can be made: dairy-free/);
  assert.match(items[2].sellingNotes, /Allergen notes: in the glaze/);
});

test('plain menus (name … price) still use the simple reader', () => {
  const rows = menuFromText('STARTERS\nFries ..... 6\nWings ..... 12\nDESSERTS\nCake ..... 9');
  assert.deepEqual(rows.map((r) => [r.values.category, r.values.name, r.values.price]), [['Starters', 'Fries', '6'], ['Starters', 'Wings', '12'], ['Desserts', 'Cake', '9']]);
});
