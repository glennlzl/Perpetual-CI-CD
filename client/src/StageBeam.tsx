import { useReducedMotion } from 'motion/react';
import { BorderBeam } from '@/components/ui/border-beam';

// The light that runs along a stage card while Autopilot works on it. One
// comet, warm head fading to a violet tail, from the theme's beam tokens. With
// reduced motion the card keeps a still ring in the head colour instead.
export function StageBeam() {
  const still = useReducedMotion();
  if (still) return <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-(--beam-head)" aria-hidden="true" />;
  return <BorderBeam size={90} duration={4} borderWidth={2} colorFrom="var(--beam-head)" colorTo="var(--beam-tail)" />;
}
