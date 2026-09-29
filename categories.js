// Guesses a grocery category from an item name, so the basket and the PDF
// can group items the way a shop's aisles are laid out. Returns null when
// unsure (shown as "Other") - it never guesses prices or products.
const { normaliseKey, singular } = require("./text-keys");

const CATEGORY_WORDS = [
  ["Bakery", ["bread", "roll", "bun", "loaf", "wrap", "muffin", "rusk"]],
  ["Dairy & eggs", ["milk", "egg", "cheese", "yoghurt", "yogurt", "butter", "margarine", "cream", "maas", "amasi"]],
  ["Meat & fish", ["chicken", "beef", "mince", "pork", "wors", "boerewors", "polony", "sausage", "fish", "pilchard", "tuna", "viennas"]],
  ["Fruit & veg", ["apple", "banana", "orange", "potato", "onion", "tomato", "carrot", "cabbage", "spinach", "lettuce", "fruit", "vegetable"]],
  ["Pantry", ["rice", "pasta", "macaroni", "spaghetti", "maize", "meal", "mealie", "flour", "sugar", "salt", "oil", "bean", "lentil",
    "peanut", "jam", "cereal", "oats", "cornflake", "noodle", "soup", "spice", "sauce", "tea", "coffee", "atchar", "samp"]],
  ["Drinks", ["juice", "cold drink", "cooldrink", "soda", "coke", "water", "cordial", "energy drink"]],
  ["Snacks", ["chip", "crisp", "biscuit", "chocolate", "sweet", "popcorn", "nut", "snack"]],
  ["Household", ["toilet paper", "toilet roll", "detergent", "washing", "dishwashing", "bleach", "sponge", "refuse bag", "bin bag", "candle", "matches", "foil"]],
  ["Toiletries", ["soap", "shampoo", "toothpaste", "toothbrush", "deodorant", "roll on", "lotion", "sanitary", "pad", "tampon", "razor", "vaseline"]],
];

function guessCategory(name) {
  const words = normaliseKey(name).split(" ").filter(Boolean).map(singular);
  const text = " " + words.join(" ") + " ";
  for (const [category, keys] of CATEGORY_WORDS) {
    if (keys.some(k => text.includes(" " + k.split(" ").map(singular).join(" ") + " "))) return category;
  }
  return null;
}

module.exports = { guessCategory, CATEGORIES: CATEGORY_WORDS.map(([c]) => c) };
