export type Order = {
  id: string
  number: number
  total: string
}

export async function fetchOrders(): Promise<Order[]> {
  const res = await fetch("/api/orders")
  if (!res.ok) throw new Error(`orders: ${res.status}`)
  return res.json()
}
