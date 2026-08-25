/**
 * Sibling order keys.
 *
 * v1 only ever appends: Tab adds a last child, Enter adds a next sibling.
 * There is no drag-to-reorder yet, so this needs exactly one operation --
 * "a key after the current last sibling" -- not a general insert-between.
 *
 * Two clients that append a sibling under the same parent at the same time
 * both start from the same "current last" key and can legitimately produce
 * the same `orderKeyAfter` result. That is not a bug to prevent: `model.ts`'s
 * `compareMindMapSiblings` breaks the tie on `elementId`, which every client
 * computes the same way from data both already have. The two new nodes end
 * up adjacent, in a deterministic order, on every client -- exactly what the
 * epic's two-client acceptance asks for.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const MIDPOINT = "m";

/**
 * A key that sorts after every key in `existingKeys`, or after `null`
 * (the map's first key) when there are none.
 *
 * Strategy: bump the last character of the greatest existing key to the next
 * symbol in the alphabet. If that character is already the last symbol,
 * append a fresh middle character instead -- lexicographic comparison always
 * puts a string after its own strict prefix, so `"z" < "zm"` holds no matter
 * how long `"z"` already is. Either branch strictly increases the key, and
 * repeating it never needs to renumber anything that came before.
 */
export const orderKeyAfter = (existingKeys: readonly string[]): string => {
  const greatest = existingKeys.reduce<string | null>(
    (max, key) => (max === null || key > max ? key : max),
    null,
  );
  if (greatest === null || greatest.length === 0) return MIDPOINT;

  const lastChar = greatest[greatest.length - 1];
  const index = ALPHABET.indexOf(lastChar);
  if (index >= 0 && index < ALPHABET.length - 1) {
    return greatest.slice(0, -1) + ALPHABET[index + 1];
  }
  return greatest + MIDPOINT;
};
