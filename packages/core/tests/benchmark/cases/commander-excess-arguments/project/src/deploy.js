function deploy(env, services) {
  console.log(`deploying ${services.join(", ")} to ${env}`)
}

module.exports = { deploy }
