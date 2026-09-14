import express from "express"
import helmet from "helmet"

const app = express()
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { scriptSrc: ["self", "cdn.example.com"] },
    },
  })
)

export default app
