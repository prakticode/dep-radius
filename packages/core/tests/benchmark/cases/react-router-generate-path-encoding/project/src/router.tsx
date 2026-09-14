import { createBrowserRouter } from "react-router"
import { SearchBox } from "./search/SearchBox"
import { SearchPage } from "./search/SearchPage"

export const router = createBrowserRouter([
  { path: "/", element: <SearchBox /> },
  { path: "/search/:query", element: <SearchPage /> },
])
