export function isPollDue(
  lastPollAt: string | null,
  intervalSeconds: number | null,
  now: Date,
): boolean {
  if (lastPollAt === null) return true
  const interval = intervalSeconds ?? 60
  return (now.getTime() - new Date(lastPollAt).getTime()) / 1000 >= interval
}
