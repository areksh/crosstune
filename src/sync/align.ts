/** Lining up two lists of ids: which place of one is which place of the other. */

/**
 * Pair the places of two lists holding equal ids. A longest common run is
 * paired first, so that of several copies of one song the right one is taken as
 * gone or new; what is left is paired in order (those moved). Returns, for each
 * place of `from`, its place in `to`, or -1.
 */
export function align<T>(from: readonly T[], to: readonly T[]): number[] {
  const pairs = new Array<number>(from.length).fill(-1);
  const taken = new Set<number>();
  for (const [i, j] of commonRun(from, to)) {
    pairs[i] = j;
    taken.add(j);
  }
  const spare = new Map<T, number[]>();
  to.forEach((id, j) => {
    if (!taken.has(j)) {
      spare.set(id, [...(spare.get(id) ?? []), j]);
    }
  });
  from.forEach((id, i) => {
    if (pairs[i] === -1) {
      pairs[i] = spare.get(id)?.shift() ?? -1;
    }
  });
  return pairs;
}

/** A longest common subsequence, as pairs of places. */
function commonRun<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  // Equal ends need no table; edits are usually few.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let [endA, endB] = [a.length, b.length];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i += 1) {
    pairs.push([i, i]);
  }
  const [rows, columns] = [endA - start, endB - start];
  const width = columns + 1;
  const table = new Uint16Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < rows && j < columns; ) {
    if (a[start + i] === b[start + j]) {
      pairs.push([start + i, start + j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  for (let k = 0; endA + k < a.length; k += 1) {
    pairs.push([endA + k, endB + k]);
  }
  return pairs;
}

/**
 * The numbers of an order that may have moved: those that some longest rising
 * run leaves out. Where two swapped places, either may be the one that moved,
 * so both count.
 */
export function maybeMoved(order: readonly number[]): Set<number> {
  const n = order.length;
  const ending = lengths(order);
  // The longest run starting at each place: the same, read backwards.
  const starting = lengths([...order].reverse().map((value) => -value)).reverse();
  const best = Math.max(0, ...ending);
  const inSome = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    if (ending[i]! + starting[i]! - 1 === best) {
      inSome.set(ending[i]!, (inSome.get(ending[i]!) ?? 0) + 1);
    }
  }
  return new Set(
    order.filter((_, i) => ending[i]! + starting[i]! - 1 !== best || inSome.get(ending[i]!) !== 1),
  );
}

/** The length of the longest rising run ending at each place. */
function lengths(values: readonly number[]): number[] {
  const tails: number[] = [];
  return values.map((value) => {
    let [low, high] = [0, tails.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]! < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    tails[low] = value;
    return low + 1;
  });
}
