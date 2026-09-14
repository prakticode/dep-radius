import { useQuery } from "@tanstack/react-query"
import { fetchOrders } from "../api/orders"

export function OrdersTab({ active }: { active: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: fetchOrders,
    subscribed: active,
  })

  if (isLoading) return <p>Loading orders…</p>
  if (!data?.length) return <p>You have no orders yet.</p>

  return (
    <ul>
      {data.map((order) => (
        <li key={order.id}>
          #{order.number} · {order.total}
        </li>
      ))}
    </ul>
  )
}
