// Corporate action detection — CLAUDE.md §6.1, extended after real evidence
// (see below).
//
// Pure function: no DB, no network, no clock. Input is one symbol's bars,
// ascending by date; output is a list of candidate actions to review.
//
// Two independent triggers, either one flags a candidate:
//
// 1. prevClose discontinuity: the exchange's own `prev_close` on a given day
//    is SOMETIMES its adjusted reference price, in which case it breaks its
//    normal equality with the previous session's close on a corporate
//    action. CLAUDE.md §6.1 originally treated this as the sole, reliable
//    signal. Threshold: >2%, per CLAUDE.md — this field is either exactly
//    equal to the prior close or genuinely adjusted, so a small deviation is
//    already meaningful.
//
// 2. close-to-close jump: added after confirming against real production
//    data that trigger #1 alone MISSES real, undisputed corporate actions.
//    RELIANCE's actual 1:1 bonus (ex-date 2024-10-27) shows prev_close
//    exactly equal to the prior close (2655.70 both) — NSE did not publish
//    an adjusted reference for this one — so only the close-to-close jump
//    (2655.70 -> 1334.35) carries the signal.
//
//    This trigger is deliberately much less sensitive than #1: an early,
//    flat 2% version of this was tested against the real local archive and
//    produced 190,000+ candidates (one volatile smallcap alone generated
//    437), because ordinary daily volatility routinely exceeds 2%. Every
//    real candidate ratio here implies at least a 33% price move (the
//    smallest is a 2:1/1:2 split, a 50% move), so the threshold is raised
//    to 30% — comfortably below any real split's effect, comfortably above
//    typical circuit-band daily moves — and a "fit quality" gate additionally
//    requires the raw ratio to land close to an actual plausible split
//    ratio, not just far from 1. A random 35-45% move that isn't close to
//    any nice ratio is rejected even though it clears the 30% threshold.
import type { BarForDetection, DetectedAction } from "./types";

const PREV_CLOSE_THRESHOLD = 0.02; // CLAUDE.md §6.1: >2% deviation
const CLOSE_JUMP_THRESHOLD = 0.3; // see comment above — real splits are all >=33%
const MAX_FIT_LOG_DISTANCE = 0.15; // ~16% multiplicative tolerance around the nearest candidate

// Curated set of "sensible" ratios to snap a noisy raw jump onto. Splits and
// bonuses both increase share count (factor > 1) and are indistinguishable
// from price action alone — default-classified as "split"; a human corrects
// to "bonus" where relevant during review (CLAUDE.md §6.3).
const CANDIDATES: { factor: number; num: number; den: number }[] = [
  { factor: 1 / 10, num: 1, den: 10 },
  { factor: 1 / 5, num: 1, den: 5 },
  { factor: 1 / 4, num: 1, den: 4 },
  { factor: 1 / 3, num: 1, den: 3 },
  { factor: 1 / 2, num: 1, den: 2 },
  { factor: 2, num: 2, den: 1 },
  { factor: 3, num: 3, den: 1 },
  { factor: 4, num: 4, den: 1 },
  { factor: 5, num: 5, den: 1 },
  { factor: 10, num: 10, den: 1 },
  { factor: 20, num: 20, den: 1 },
  { factor: 25, num: 25, den: 1 },
  { factor: 50, num: 50, den: 1 },
  { factor: 100, num: 100, den: 1 },
];

function snapToNearestCandidate(rawFactor: number) {
  let best = CANDIDATES[0];
  let bestDist = Infinity;
  for (const c of CANDIDATES) {
    // Compare in log-space: ratios are multiplicative, so this weighs
    // "off by 2x" the same whether the true factor is 2 or 50.
    const dist = Math.abs(Math.log(rawFactor) - Math.log(c.factor));
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return { ...best, distance: bestDist };
}

export function detectCorporateActions(bars: BarForDetection[]): DetectedAction[] {
  const out: DetectedAction[] = [];

  for (let i = 1; i < bars.length; i++) {
    const prior = bars[i - 1];
    const today = bars[i];
    if (prior.close === null || prior.close <= 0) continue;

    const prevCloseRatio =
      today.prevClose !== null && today.prevClose > 0 ? today.prevClose / prior.close : null;
    const closeRatio = today.close !== null && today.close > 0 ? today.close / prior.close : null;

    const prevCloseTriggers = prevCloseRatio !== null && Math.abs(prevCloseRatio - 1) > PREV_CLOSE_THRESHOLD;
    const closeTriggers = closeRatio !== null && Math.abs(closeRatio - 1) > CLOSE_JUMP_THRESHOLD;
    if (!prevCloseTriggers && !closeTriggers) continue;

    // Prefer the prevClose signal when it fires — it's the exchange's own
    // stated reference — falling back to the close-to-close jump when the
    // exchange didn't publish an adjusted prevClose for this action.
    const triggerRatio = prevCloseTriggers ? (prevCloseRatio as number) : (closeRatio as number);
    const triggerSource = prevCloseTriggers ? "prev_close" : "close";
    const rawFactor = 1 / triggerRatio; // divide old prices by this to reach new scale
    const snapped = snapToNearestCandidate(rawFactor);

    // Fit-quality gate: reject if the raw move isn't actually close to any
    // plausible split ratio — this is what separates a real corporate
    // action from an ordinary large price move.
    if (snapped.distance > MAX_FIT_LOG_DISTANCE) continue;

    out.push({
      exDate: today.date,
      type: snapped.factor > 1 ? "split" : "consolidation",
      ratioNumerator: snapped.num,
      ratioDenominator: snapped.den,
      adjFactor: snapped.factor,
      rawRatio: rawFactor,
      notes: `Detected via ${triggerSource} jump: ${triggerSource === "prev_close" ? today.prevClose : today.close} vs prior close ${prior.close} (raw factor ${rawFactor.toFixed(4)}, snapped to ${snapped.num}:${snapped.den}, fit distance ${snapped.distance.toFixed(3)})`,
    });
  }

  return out;
}
