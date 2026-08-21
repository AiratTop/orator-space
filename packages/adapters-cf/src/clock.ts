import type { Clock } from "@orator/core/ports";

export const systemClock: Clock = { now: () => new Date() };
