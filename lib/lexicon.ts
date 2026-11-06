/**
 * Telling a shop from an item, for the setup chat ("Which shops do you use?" -> "milk").
 * No AI: known UK chains and shop words mean a shop; known groceries (and anything the
 * family's list already knows) mean an item. Anything else is left for the caller to decide.
 */
import { findFamilyWord, itemVariants, normalise, type SynonymGroups } from "./matching";

const CHAINS = /\b(?:tesco|sainsbury'?s?|asda|morrisons|aldi|lidl|waitrose|m\s*&\s*s|marks(?:\s+(?:and|&)\s+spencers?)?|co-?op|iceland|costco|boots|superdrug|ocado|amazon|lloyds|holland\s*(?:&|and)\s*barrett|primark|ikea|b\s*&\s*q|wilko|poundland|home\s+bargains|b\s*&\s*m|farmfoods|spar|londis|whole\s+foods|makro|booker|tk\s*maxx|argos|currys|screwfix|dunelm|the\s+range|pets\s+at\s+home|smyths|deliveroo|uber\s+eats|just\s+eat|getir|gorillas|zapp)\b/i;
const SHOP_WORDS = /\b(?:shop|shops|store|stores|grocer|grocers|grocery|supermarket|market|butcher|butchers|baker|bakers|bakery|chemist|chemists|pharmacy|florist|florists|fishmonger|deli|mart|cash\s*(?:and|&)\s*carry|wholesale|wholesaler|newsagent|off\s*licen[cs]e|garden\s+centre|cinema|theatre|restaurant|online)\b/i;

const GROCERIES = ["milk", "bread", "egg", "rice", "dal", "dhal", "oil", "salt", "sugar", "tea", "coffee", "flour", "atta", "onion",
  "tomato", "potato", "chilli", "chili", "garlic", "ginger", "curd", "yoghurt", "yogurt", "butter", "cheese", "paneer", "ghee",
  "chicken", "fish", "meat", "lamb", "mince", "veg", "vegetable", "fruit", "banana", "apple", "orange", "lemon", "lime", "grape",
  "coriander", "spinach", "juice", "water", "biscuit", "cereal", "oats", "pasta", "noodle", "soap", "shampoo", "toothpaste",
  "toilet roll", "kitchen roll", "tissue", "nappies", "nappy", "wipes", "detergent", "washing", "bleach", "bin bag", "foil",
  "masala", "spice", "curry leaves", "cream", "honey", "jam", "nuts", "snack", "crisps", "chocolate", "wine", "beer", "flowers",
  "paracetamol", "medicine", "plasters", "batteries", "bulb", "carrot", "cucumber", "lettuce", "peas", "beans", "lentil", "sauce",
  "ketchup", "mayo", "vinegar", "pepper", "cumin", "turmeric", "yeast", "cake", "ice cream", "pizza", "sausage", "bacon", "ham",
  "tuna", "salmon", "prawn", "tofu", "hummus", "bagel", "wrap", "tortilla", "okra", "aubergine", "courgette", "mushroom", "avocado",
  "paal", "thayir", "muttai", "arisi", "doodh", "dahi", "anda", "chawal", "namak", "cheeni", "thakkali"];

/** Clearly a shop: a known chain, or a shop word ("the Indian shop", "butcher"). */
export function isShopName(name: string): boolean {
  return CHAINS.test(name) || SHOP_WORDS.test(name);
}

/** Clearly an item: something the list knows, or a common grocery. */
export function looksLikeItem(name: string, knownItems: string[] = [], groups?: SynonymGroups): boolean {
  const key = normalise(name);
  if (!key) return false;
  const variants = itemVariants(key);
  if (knownItems.some((k) => variants.has(normalise(k)))) return true;
  if (groups && findFamilyWord(key, groups)) return true;
  return GROCERIES.some((g) => new RegExp(`(^|\\s)${g.replace(/\s+/g, "\\s+")}(?:e?s)?($|\\s)`, "i").test(key));
}

/**
 * Splits a setup answer's names into shops and items. Shops win over items
 * ("Indian grocer", "Costco"); unclear names are treated as shops, since shops were asked for.
 */
export function splitShopsAndItems(names: string[], knownItems: string[] = [], groups?: SynonymGroups): { shops: string[]; items: string[] } {
  const shops: string[] = [], items: string[] = [];
  for (const n of names) {
    if (isShopName(n)) shops.push(n);
    else if (looksLikeItem(n, knownItems, groups)) items.push(n);
    else shops.push(n);
  }
  return { shops, items };
}
