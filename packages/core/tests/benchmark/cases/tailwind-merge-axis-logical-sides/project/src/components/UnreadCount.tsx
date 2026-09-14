import { Badge } from "./Badge"

export function UnreadCount({ count }: { count: number }) {
  return <Badge className="px-1.5 bg-red-600 text-white">{count}</Badge>
}
