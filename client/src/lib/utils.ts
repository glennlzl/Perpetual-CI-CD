import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

/** Page visibility, as polling reads it: the document, or a stand-in with the same fields. */
export interface PageVisibility {
  readonly hidden: boolean;
  addEventListener?(type: 'visibilitychange', listener: () => void): void;
  removeEventListener?(type: 'visibilitychange', listener: () => void): void;
}
/** The timer functions polling schedules with: globalThis, or a stand-in. A handle is whatever setTimeout returned. */
export interface Timers { setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void }
