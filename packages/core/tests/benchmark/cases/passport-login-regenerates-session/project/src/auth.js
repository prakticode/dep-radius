const express = require("express")
const passport = require("passport")
const { Strategy: LocalStrategy } = require("passport-local")
const users = require("./users")

passport.use(
  new LocalStrategy(async (username, password, done) => {
    const user = await users.verify(username, password)
    done(null, user || false)
  })
)

passport.serializeUser((user, done) => done(null, user.id))
passport.deserializeUser((id, done) => users.findById(id).then((user) => done(null, user), done))

function requireLogin(req, res, next) {
  if (req.isAuthenticated()) return next()
  req.session.returnTo = req.originalUrl
  res.redirect("/login")
}

const router = express.Router()

router.post(
  "/login",
  passport.authenticate("local", { successReturnToOrRedirect: "/", failureRedirect: "/login" })
)

module.exports = { router, requireLogin }
