import ky from "ky"

export const api = ky.create({
  prefixUrl: "https://api.example.com",
  retry: {
    limit: 3,
    methods: ["GET", "POST"],
  },
})

export function createOrder(order: { sku: string; quantity: number }) {
  return api.post("orders", { json: order }).json()
}
