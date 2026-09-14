import axios from "axios"

const http = axios.create({
  adapter: "fetch",
  timeout: 10_000,
  maxContentLength: 2 * 1024 * 1024,
})

export async function downloadAvatar(url: string): Promise<ArrayBuffer> {
  const response = await http.get<ArrayBuffer>(url, { responseType: "arraybuffer" })
  return response.data
}
