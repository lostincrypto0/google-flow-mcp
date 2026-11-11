// Reading Flow's clip-length slider as SECONDS. Pure, so `npm test` can check it without Chrome.
//
// Bug found 2026-11-11: Omni 1.2's Length slider runs from 3 s to 15 s, but its aria-valuenow is the POSITION
// (0 to 12), not the seconds. pickDuration compared that position with the wanted seconds, so asking for 4 s stopped
// at position 4, which Flow shows as 7 s, and asking for 5 s gave 8 s. Both clips were generated and charged at the
// wrong length (7 s = 21 credits, 8 s = 24 credits), and the read-back "confirmed" the wrong value.
//
// Order of trust: the slider's own text ("7s", "7 seconds"), then the numbers with the minimum taken into account.

export interface SliderReading {
  now?: string | null; // aria-valuenow, or the input's value
  text?: string | null; // aria-valuetext
  min?: string | null; // aria-valuemin, or the input's min
  max?: string | null; // aria-valuemax, or the input's max
}

// Seconds the slider currently stands for, or NaN when it cannot be read.
export function sliderSeconds(r: SliderReading, wantedMin = 3, wantedMax = 15): number {
  const fromText = Number(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i.exec(r.text ?? "")?.[1] ?? NaN);
  if (Number.isFinite(fromText)) return fromText;
  const now = Number(r.now ?? NaN);
  if (!Number.isFinite(now)) return NaN;
  const min = Number(r.min ?? NaN);
  const max = Number(r.max ?? NaN);
  // A slider that spans exactly the length range (3..15) is in seconds already.
  if (min === wantedMin && max === wantedMax) return now;
  // A slider with as many steps as the length range (12) but counted from another number is a position:
  // position 0 is the shortest length.
  if (Number.isFinite(min) && Number.isFinite(max) && max - min === wantedMax - wantedMin) return now - min + wantedMin;
  return now;
}
