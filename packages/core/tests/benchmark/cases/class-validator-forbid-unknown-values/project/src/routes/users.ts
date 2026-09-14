import { Router } from "express"
import { CreateUserDto } from "../dto/create-user"
import { UpdatePreferencesDto } from "../dto/update-preferences"
import { validateBody } from "../middleware/validate-body"

const router = Router()

router.post("/users", validateBody(CreateUserDto), (req, res) => {
  res.status(201).json({ email: req.body.email })
})

router.patch("/users/me/preferences", validateBody(UpdatePreferencesDto), (req, res) => {
  res.json(req.body)
})

export default router
