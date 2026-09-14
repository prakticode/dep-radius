import { useParams } from "react-router"

export function SearchPage() {
  const { query = "" } = useParams()

  return <h1>Results for “{query}”</h1>
}
