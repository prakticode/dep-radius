import { useState } from "react"
import { generatePath, useNavigate } from "react-router"

export function SearchBox() {
  const [query, setQuery] = useState("")
  const navigate = useNavigate()

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        navigate(generatePath("/search/:query", { query: encodeURIComponent(query.trim()) }))
      }}
    >
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tracks" />
      <button type="submit">Search</button>
    </form>
  )
}
